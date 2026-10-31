import { Router } from 'express';
import { Types, type FilterQuery, type Model } from 'mongoose';
import { AuditQuery, ObjectIdString, ROLES, type AuditResponse, type OpsResponse } from '@locallens/contracts';
import type { Config } from '../../config';
import { Errors } from '../../lib/errors';
import { currentUser, requireRole } from '../../middleware/auth';
import { AssistantCacheModel } from '../assistant/assistant';
import { audit, AuditEventModel, type AuditEvent } from '../audit/audit';
import { UserModel } from '../identity/models';
import { JobModel, openBreakers } from '../jobs/jobs';
import { ContentReportModel } from '../moderation/reports';
import { AppealModel, SubmissionModel } from '../newsroom/submission.model';
import { NotificationModel } from '../notifications/notifications';
import { ArticleModel, ArticleRevisionModel } from '../publishing/article.model';
import { VerificationReportModel } from '../verification/verification';

/** Admin-only: one page that says whether the newsroom and its background work are healthy, plus the audit log. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any mongoose model; the pipeline below is fixed
const countBy = async (model: Model<any>, field: string, match: FilterQuery<unknown> = {}): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await model.aggregate<{ _id: unknown; n: number }>([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map((g) => [String(g._id), g.n]),
  );

export function adminOpsRouter(config: Config): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/ops', async (_req, res) => {
    const day = 86_400_000;
    const now = Date.now();
    const [roleCounts, totalUsers, suspended, pendingReporters, byStatus, oldest, highRisk, openAppeals, openReports] = await Promise.all([
      Promise.all(ROLES.map(async (role) => [role, await UserModel.countDocuments({ roles: role })] as const)),
      UserModel.estimatedDocumentCount(),
      UserModel.countDocuments({ status: 'suspended' }),
      UserModel.countDocuments({ 'reporterRequest.status': 'pending' }),
      countBy(SubmissionModel, 'status', { status: { $ne: 'draft' } }),
      SubmissionModel.findOne({ status: 'submitted' }, { submittedAt: 1 }).sort({ submittedAt: 1 }).lean(),
      SubmissionModel.countDocuments({ status: { $in: ['submitted', 'in_review'] }, riskLevel: 'high' }),
      AppealModel.countDocuments({ status: 'open' }),
      ContentReportModel.countDocuments({ status: 'open' }),
    ]);
    const [published, publishedRecent, corrections, retracted, jobGroups, problems, verifications, cached, notifications] = await Promise.all([
      ArticleModel.countDocuments({ status: 'published' }),
      ArticleModel.countDocuments({ firstPublishedAt: { $gte: new Date(now - 7 * day) } }),
      ArticleRevisionModel.countDocuments({ createdAt: { $gte: new Date(now - 7 * day) }, changeKind: { $in: ['correction', 'clarification'] } }),
      ArticleModel.countDocuments({ status: 'retracted' }),
      JobModel.aggregate<{ _id: { type: string; status: string }; n: number }>([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]),
      JobModel.find({ status: { $in: ['failed', 'dead'] } }).sort({ updatedAt: -1 }).limit(20).lean(),
      countBy(VerificationReportModel, 'status', { requestedAt: { $gte: new Date(now - 7 * day) } }),
      AssistantCacheModel.countDocuments({ expiresAt: { $gt: new Date() } }),
      NotificationModel.countDocuments({ createdAt: { $gte: new Date(now - day) } }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      users: { total: totalUsers, byRole: Object.fromEntries(roleCounts), suspended, pendingReporterRequests: pendingReporters },
      newsroom: {
        byStatus,
        oldestWaitingHours: oldest?.submittedAt ? Math.round((now - oldest.submittedAt.getTime()) / 3_600_000) : null,
        highRiskWaiting: highRisk,
        openAppeals,
        openReports,
      },
      articles: { published, publishedLast7Days: publishedRecent, correctionsLast7Days: corrections, retracted },
      jobs: {
        byTypeAndStatus: jobGroups.map((g) => ({ type: g._id.type, status: g._id.status, count: g.n })).sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status)),
        problems: problems.map((j) => ({ id: j._id.toHexString(), type: j.type, status: j.status, attempts: j.attempts, lastError: j.lastError, updatedAt: j.updatedAt.toISOString() })),
        breakersOpen: openBreakers(),
      },
      ai: { configured: !!config.AI_SERVICE_URL, verificationsLast7Days: verifications, assistantCachedAnswers: cached },
      notificationsLast24Hours: notifications,
    } satisfies OpsResponse);
  });

  /** Put a failed/dead job back in the queue (e.g. after fixing the AI service). */
  r.post('/jobs/:id/retry', async (req, res) => {
    const id = ObjectIdString.parse(req.params.id);
    const job = await JobModel.findOneAndUpdate(
      { _id: id, status: { $in: ['failed', 'dead'] } },
      { $set: { status: 'pending', attempts: 0, runAfter: new Date(), lockedUntil: null, lockedBy: null, lastError: null } },
      { new: true },
    );
    if (!job) throw Errors.conflict('Only failed jobs can be retried');
    await audit(req, { action: 'job.retried', actorId: currentUser(req)._id, targetType: 'job', targetId: id, metadata: { type: job.type } });
    res.json({ message: 'Queued again' });
  });

  r.get('/audit', async (req, res) => {
    const q = AuditQuery.parse(req.query);
    const filter: FilterQuery<AuditEvent> = {};
    if (q.action) filter.action = q.action.endsWith('.') ? { $regex: `^${q.action.replaceAll('.', '\\.')}` } : q.action;
    if (q.actorId) filter.actorId = new Types.ObjectId(q.actorId);
    if (q.targetId) filter.targetId = q.targetId;
    if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
    const docs = await AuditEventModel.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
    const page = docs.slice(0, q.limit);
    const actors = await UserModel.find({ _id: { $in: page.map((d) => d.actorId).filter(Boolean) } }, { email: 1, displayName: 1 }).lean();
    const byId = new Map(actors.map((a) => [a._id.toHexString(), a]));
    res.json({
      items: page.map((d) => {
        const actor = d.actorId ? byId.get(d.actorId.toHexString()) : undefined;
        return {
          id: d._id.toHexString(),
          at: d.at.toISOString(),
          action: d.action,
          actor: actor ? { id: actor._id.toHexString(), email: actor.email, displayName: actor.displayName } : null,
          targetType: d.targetType,
          targetId: d.targetId,
          ip: d.ip,
          metadata: d.metadata ?? {},
        };
      }),
      nextCursor: docs.length > q.limit ? (page.at(-1)?._id.toHexString() ?? null) : null,
    } satisfies AuditResponse);
  });

  return r;
}
