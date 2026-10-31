import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backoffMs, breakerOpen, JobModel, resetBreakers, RETRY, runDueJobs } from '../src/modules/jobs/jobs';
import { SubmissionModel } from '../src/modules/newsroom/submission.model';
import { VerificationReportModel } from '../src/modules/verification/verification';
import { categoryId, createTree } from './fixtures';
import { buildApp, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

const logger = pino({ level: 'silent' });
const TOKEN = 'x'.repeat(40);

// A fake AI service whose replies each test scripts.
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let received: { token: string | undefined; body: Record<string, unknown> }[] = [];
let server: Server;
let aiUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ token: req.headers['x-service-token'] as string | undefined, body: JSON.parse(raw || '{}') });
      const reply = replies.shift() ?? { status: 500, body: { error: { message: 'no scripted reply' } } };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  aiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  replies = [];
  received = [];
  resetBreakers();
});

const RESULT = (recommendation = 'standard_review') => ({
  detected_language: 'en',
  language_matches_declared: true,
  claims: [
    {
      id: 'C1',
      text: 'Street lights on Market Road are off.',
      kind: 'factual',
      check_worthy: true,
      assessment: recommendation === 'senior_review' ? 'contradicted' : 'supported',
      supporting_evidence_ids: [],
      contradicting_evidence_ids: [],
      rationale: 'test',
      missing_evidence: [],
      uncertainty: '',
    },
  ],
  evidence: [],
  sources: [],
  recommendation,
  meta: { pipeline_version: 'verify-1.0.0', provider: 'scripted', model: 'm', prompt_versions: { extract_claims: 'claims-v1' }, duration_ms: 5, warnings: [] },
});

async function setup(aiOn = true) {
  const config = testConfig(aiOn ? { AI_SERVICE_URL: aiUrl, AI_SERVICE_TOKEN: TOKEN } : {});
  const { app } = buildApp({ config });
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const reporter = await userWithRoles(app, 'reporter@example.in', ['reader', 'reporter']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const submit = async () => {
    const draft = (
      await reporter
        .post('/api/v1/submissions', {
          headline: 'Street lights not working on Market Road',
          summary: 'Residents say the street lights have been off for a week.',
          body: 'All twelve street lights on Market Road have been off since last Monday.',
          language: 'en',
          locationId: tree.village.id,
          categoryId: civic,
          supportingUrls: ['https://example.org/notice'],
        })
        .expect(201)
    ).body.submission;
    return (await reporter.post(`/api/v1/submissions/${draft.id}/submit`, {}).expect(200)).body.submission;
  };
  return { app, editor, reporter, submit };
}

/** Make every pending job due now (skips the real backoff delay in tests). */
const makeDue = () => JobModel.updateMany({ status: 'pending' }, { $set: { runAfter: new Date(0) } });

describe('AI verification', () => {
  it('is off unless configured: submissions go straight to editors', async () => {
    const { submit } = await setup(false);
    const sub = await submit();
    expect(sub.aiStatus).toBe('not_requested');
    expect(await JobModel.countDocuments()).toBe(0);
  });

  it('queues an analysis on submit and stores the result for editors', async () => {
    const { editor, submit } = await setup();
    const sub = await submit();
    expect(sub.aiStatus).toBe('pending'); // the reporter's response reflects the queued analysis
    expect((await SubmissionModel.findById(sub.id))?.aiStatus).toBe('pending');
    replies.push({ status: 200, body: RESULT() });

    expect(await runDueJobs(logger)).toBe(1);
    expect(received[0]?.token).toBe(TOKEN);
    expect(received[0]?.body).toMatchObject({ submission_id: sub.id, language: 'en', location_label: 'Alpha Village, Alpha Mandal, Test District', supporting_urls: ['https://example.org/notice'] });

    const res = await editor.get(`/api/v1/editorial/submissions/${sub.id}/verification`).expect(200);
    expect(res.body.report).toMatchObject({ status: 'completed', submissionVersion: 1, result: { recommendation: 'standard_review' } });
    expect((await SubmissionModel.findById(sub.id))?.aiStatus).toBe('completed');
  });

  it('never blocks or changes editorial decisions: editors can publish while the AI is still running', async () => {
    const { editor, submit } = await setup();
    const sub = await submit();
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'citizen_reviewed' }).expect(200);
    replies.push({ status: 200, body: RESULT('senior_review') });
    await runDueJobs(logger);
    const after = await SubmissionModel.findById(sub.id);
    expect(after?.status).toBe('published'); // the late analysis did not touch a decided submission
    expect(received).toHaveLength(0);
  });

  it('transient failures retry with backoff, then become "unavailable" — never approval', async () => {
    const { editor, submit } = await setup();
    const sub = await submit();
    for (let i = 0; i < 6; i++) replies.push({ status: 503, body: { error: { message: 'model down', transient: true } } });

    await runDueJobs(logger);
    let job = await JobModel.findOne();
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() - 1000);

    for (let i = 0; i < 5; i++) {
      resetBreakers();
      await makeDue();
      await runDueJobs(logger);
    }
    job = await JobModel.findOne();
    expect(job).toMatchObject({ status: 'dead', attempts: 6 });
    const after = await SubmissionModel.findById(sub.id);
    expect(after).toMatchObject({ status: 'submitted', aiStatus: 'unavailable' });
    const report = (await editor.get(`/api/v1/editorial/submissions/${sub.id}/verification`)).body.report;
    expect(report).toMatchObject({ status: 'unavailable', attempts: 6 });
    expect(report.error).toMatch(/Review manually/);
  });

  it('permanent errors and malformed analyses are not retried', async () => {
    const { submit } = await setup();
    const a = await submit();
    replies.push({ status: 422, body: { error: { message: 'model declined', transient: false } } });
    await runDueJobs(logger);
    expect(await JobModel.findOne({ 'payload.submissionId': a.id })).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await SubmissionModel.findById(a.id))?.aiStatus).toBe('failed');

    const b = await submit();
    replies.push({ status: 200, body: { claims: 'not what we expect' } });
    await runDueJobs(logger);
    expect((await VerificationReportModel.findOne({ submissionId: b.id }))?.status).toBe('failed');
  });

  it('conflicting evidence adds scrutiny: the submission becomes high risk', async () => {
    const { editor, submit } = await setup();
    const sub = await submit();
    replies.push({ status: 200, body: RESULT('senior_review') });
    await runDueJobs(logger);
    const s = (await editor.get(`/api/v1/editorial/submissions/${sub.id}`).expect(200)).body.submission;
    expect(s.riskLevel).toBe('high');
    expect(s.riskReasons).toContain('conflicting_evidence');
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'citizen_reviewed' }).expect(403);
  });

  it('an analysis of an old version is skipped after the reporter resubmits', async () => {
    const { editor, reporter, submit } = await setup();
    const sub = await submit();
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/request-info`, { note: 'Please add a photo link.' }).expect(200);
    await reporter.post(`/api/v1/submissions/${sub.id}/submit`, { responseNote: 'Added.' }).expect(200);
    replies.push({ status: 200, body: RESULT() });
    await runDueJobs(logger);
    expect(received).toHaveLength(1); // only version 2 was analysed
    expect(await VerificationReportModel.findOne({ submissionId: sub.id, submissionVersion: 2 })).toMatchObject({ status: 'completed' });
  });

  it('editors can re-run an analysis that failed', async () => {
    const { editor, submit } = await setup();
    const sub = await submit();
    replies.push({ status: 422, body: { error: { message: 'bad' } } });
    await runDueJobs(logger);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/verification/retry`, {}).expect(202);
    replies.push({ status: 200, body: RESULT() });
    await runDueJobs(logger);
    expect((await SubmissionModel.findById(sub.id))?.aiStatus).toBe('completed');
  });
});

describe('job queue mechanics', () => {
  it('backoff uses full jitter within an exponential cap', () => {
    expect(backoffMs(0, () => 0.999)).toBeLessThan(RETRY.baseMs);
    expect(backoffMs(3, () => 0.5)).toBe(0.5 * RETRY.baseMs * 8);
    expect(backoffMs(30, () => 0.999)).toBeLessThan(RETRY.capMs);
    expect(backoffMs(4, () => 0)).toBe(0);
  });

  it('opens the circuit breaker after repeated transient failures', async () => {
    const { submit } = await setup();
    for (let i = 0; i < 5; i++) {
      await submit();
      replies.push({ status: 503, body: { error: { message: 'down' } } });
    }
    await runDueJobs(logger);
    expect(breakerOpen('verify_submission')).toBe(true);
    // While open, due jobs of that type are left alone.
    await makeDue();
    expect(await runDueJobs(logger)).toBe(0);
  });
});
