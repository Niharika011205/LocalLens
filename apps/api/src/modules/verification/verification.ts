import { Router } from 'express';
import { Schema, Types, model } from 'mongoose';
import type { Logger } from 'pino';
import { AiVerifyResult, ObjectIdString, type VerificationReport, type VerificationResponse } from '@locallens/contracts';
import type { Config } from '../../config';
import { Errors } from '../../lib/errors';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { CategoryModel } from '../catalog/catalog';
import { toSummary } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { enqueue, PermanentJobError, registerJobHandler, registerSweeper, type JobDoc } from '../jobs/jobs';
import { getSubmissionForEditor, setSubmittedHook } from '../newsroom/newsroom.service';
import { EditorialEventModel, SubmissionModel, type SubmissionDoc } from '../newsroom/submission.model';

/**
 * AI-assisted verification, attached to a submission but never in charge of it.
 *
 * Invariants (tested):
 * - Nothing here changes a submission's editorial status. Editors can review, reject or publish whatever the AI state.
 * - An AI failure becomes aiStatus "failed"/"unavailable" plus a manual-review note — never an approval.
 * - The only effect on the workflow is to ADD scrutiny: if the analysis finds contradicting or conflicting evidence,
 *   the submission is marked high risk (so a senior editor must publish). It never lowers risk.
 */

interface Report {
  submissionId: Types.ObjectId;
  submissionVersion: number;
  status: VerificationReport['status'];
  error: string | null;
  attempts: number;
  result: AiVerifyResult | null;
  requestedAt: Date;
  finishedAt: Date | null;
}
const reportSchema = new Schema<Report>(
  {
    submissionId: { type: Schema.Types.ObjectId, required: true },
    submissionVersion: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'unavailable'], required: true },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    result: { type: Schema.Types.Mixed, default: null },
    requestedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { minimize: false },
);
reportSchema.index({ submissionId: 1, submissionVersion: -1 }, { unique: true });
export const VerificationReportModel = model<Report>('VerificationReport', reportSchema, 'verification_reports');

export const VERIFY_JOB = 'verify_submission';
const ACTIVE_STATUSES = ['submitted', 'in_review', 'needs_info', 'returned'] as const;

export class AiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  /** Transient problems throw a plain Error (the job retries with backoff); permanent ones throw PermanentJobError. */
  async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': this.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`AI service unreachable: ${(err as Error).name}`);
    }
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return data;
    const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) throw new Error(`AI service temporarily failing: ${message}`);
    throw new PermanentJobError(`AI service rejected the request: ${message}`);
  }
}

async function buildRequest(sub: SubmissionDoc) {
  const [location, category] = await Promise.all([
    sub.locationId ? LocationModel.findById(sub.locationId) : null,
    sub.categoryId ? CategoryModel.findById(sub.categoryId, { slug: 1 }) : null,
  ]);
  return {
    submission_id: sub.id as string,
    headline: sub.headline,
    summary: sub.summary,
    body: sub.body,
    language: sub.language,
    location_label: location ? (await toSummary(location)).label : '',
    incident_date: sub.incidentDate ? sub.incidentDate.toISOString().slice(0, 10) : null,
    category: category?.slug ?? null,
    supporting_urls: sub.supportingUrls,
  };
}

async function requestVerification(sub: SubmissionDoc, suffix = ''): Promise<void> {
  const now = new Date();
  await VerificationReportModel.updateOne(
    { submissionId: sub._id, submissionVersion: sub.version },
    { $set: { status: 'pending', error: null, result: null, requestedAt: now, finishedAt: null } },
    { upsert: true },
  );
  await SubmissionModel.updateOne({ _id: sub._id, version: sub.version }, { $set: { aiStatus: 'pending' } });
  await enqueue(VERIFY_JOB, { submissionId: sub.id as string, version: sub.version }, { dedupeKey: `verify:${sub.id}:v${sub.version}${suffix}` });
}

async function finish(submissionId: Types.ObjectId, version: number, status: Report['status'], set: Partial<Report>) {
  await VerificationReportModel.updateOne({ submissionId, submissionVersion: version }, { $set: { status, finishedAt: new Date(), ...set } });
  // Only the analysis of the CURRENT version updates the submission's AI status.
  const aiStatus = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'unavailable';
  await SubmissionModel.updateOne({ _id: submissionId, version }, { $set: { aiStatus } });
}

export function configureVerification(config: Config, logger: Logger): void {
  if (!config.AI_SERVICE_URL || !config.AI_SERVICE_TOKEN) {
    logger.info('AI verification is off (AI_SERVICE_URL not set); editors review without AI analysis');
    setSubmittedHook(async () => undefined);
    return;
  }
  const client = new AiClient(config.AI_SERVICE_URL, config.AI_SERVICE_TOKEN, config.AI_TIMEOUT_MS);

  setSubmittedHook(async (sub) => {
    try {
      await requestVerification(sub);
    } catch (err) {
      // Never block the reporter's submission because the AI bookkeeping failed; the sweeper retries.
      logger.error({ err, submissionId: sub.id }, 'could not queue verification');
    }
  });

  registerJobHandler(VERIFY_JOB, {
    async run(job: JobDoc) {
      const { submissionId, version } = job.payload as { submissionId: string; version: number };
      const sub = await SubmissionModel.findById(submissionId);
      if (!sub || sub.version !== version || !ACTIVE_STATUSES.includes(sub.status as (typeof ACTIVE_STATUSES)[number])) {
        return; // superseded by a newer version, withdrawn or decided: nothing to do (idempotent)
      }
      await VerificationReportModel.updateOne({ submissionId: sub._id, submissionVersion: version }, { $set: { attempts: job.attempts } });
      const raw = await client.post('/v1/verify', await buildRequest(sub));
      const parsed = AiVerifyResult.safeParse(raw);
      if (!parsed.success) throw new PermanentJobError('AI service returned a malformed analysis');
      const result = parsed.data;
      await finish(sub._id, version, 'completed', { result, error: null, attempts: job.attempts });

      // Add scrutiny, never remove it.
      if (result.recommendation === 'senior_review' && sub.riskLevel !== 'high') {
        await SubmissionModel.updateOne({ _id: sub._id, version }, { $set: { riskLevel: 'high', riskRank: 1 }, $addToSet: { riskReasons: 'conflicting_evidence' } });
        await EditorialEventModel.create({
          submissionId: sub._id,
          actorId: null,
          actorRole: 'system',
          action: 'risk_set_high',
          fromStatus: null,
          toStatus: null,
          reasonCode: 'conflicting_evidence',
          note: 'The AI analysis found contradicting or conflicting evidence. A senior editor must review it.',
          visibleToReporter: false,
        });
      }
    },
    async onGiveUp(job, reason, error) {
      const { submissionId, version } = job.payload as { submissionId: string; version: number };
      const id = new Types.ObjectId(submissionId);
      await finish(id, version, reason === 'permanent' ? 'failed' : 'unavailable', {
        error: reason === 'permanent' ? error : 'The AI service was unavailable after several attempts. Review manually.',
        attempts: job.attempts,
      });
      await EditorialEventModel.create({
        submissionId: id,
        actorId: null,
        actorRole: 'system',
        action: 'ai_unavailable',
        fromStatus: null,
        toStatus: null,
        reasonCode: reason,
        note: 'AI analysis is not available for this version. Review manually.',
        visibleToReporter: false,
      });
    },
  });

  // Repair the gap between "submission saved" and "job queued" (e.g. a crash in between).
  registerSweeper('verification', async () => {
    const stuck = await SubmissionModel.find({
      status: { $in: [...ACTIVE_STATUSES] },
      aiStatus: { $in: ['pending', 'not_requested'] },
      submittedAt: { $ne: null },
      updatedAt: { $lt: new Date(Date.now() - 2 * 60_000) },
    }).limit(50);
    for (const sub of stuck) {
      const report = await VerificationReportModel.findOne({ submissionId: sub._id, submissionVersion: sub.version });
      if (!report || report.status === 'pending') await requestVerification(sub);
    }
  });
}

export function toReportDto(r: Report): VerificationReport {
  return {
    submissionVersion: r.submissionVersion,
    status: r.status,
    error: r.error,
    attempts: r.attempts,
    result: r.result,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export function verificationRouter(config: Config): Router {
  const r = Router();
  r.use(requireRole('editor', 'senior_editor', 'admin'));

  r.get('/submissions/:id/verification', async (req, res) => {
    const sub = await getSubmissionForEditor(currentUser(req), ObjectIdString.parse(req.params.id));
    const report = await VerificationReportModel.findOne({ submissionId: sub._id }).sort({ submissionVersion: -1 }).lean();
    res.json({ report: report ? toReportDto(report) : null } satisfies VerificationResponse);
  });

  r.post('/submissions/:id/verification/retry', async (req, res) => {
    if (!config.AI_SERVICE_URL) throw Errors.conflict('AI verification is not configured');
    const editor = currentUser(req);
    const sub = await getSubmissionForEditor(editor, ObjectIdString.parse(req.params.id));
    if (!ACTIVE_STATUSES.includes(sub.status as (typeof ACTIVE_STATUSES)[number])) throw Errors.conflict('This submission is closed');
    const current = await VerificationReportModel.findOne({ submissionId: sub._id, submissionVersion: sub.version });
    if (current?.status === 'pending') throw Errors.conflict('An analysis is already running');
    await requestVerification(sub, `:retry-${Date.now()}`);
    await audit(req, { action: 'verification.retried', actorId: editor._id, targetType: 'submission', targetId: sub.id });
    res.status(202).json({ message: 'Analysis requested' });
  });

  return r;
}
