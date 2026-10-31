import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../src/modules/audit/audit';
import { JobModel } from '../src/modules/jobs/jobs';
import { EditorialEventModel } from '../src/modules/newsroom/submission.model';
import { categoryId, createTree } from './fixtures';
import { buildApp, userWithRoles, useTestDb, type client } from './helpers';

useTestDb();

type Client = ReturnType<typeof client>;

async function setup() {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const senior = await userWithRoles(app, 'senior@example.in', ['reader', 'senior_editor']);
  const senior2 = await userWithRoles(app, 'senior2@example.in', ['reader', 'senior_editor']);
  const veteran = await userWithRoles(app, 'veteran@example.in', ['reader', 'reporter']);
  const newcomer = await userWithRoles(app, 'newcomer@example.in', ['reader', 'reporter']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  let n = 0;
  const submit = async (reporter: Client, headline?: string) => {
    n++;
    const draft = (
      await reporter
        .post('/api/v1/submissions', {
          headline: headline ?? `Street light number ${n} is broken on Market Road`,
          summary: `Residents report that street light ${n} has been off for a week.`,
          body: `Street light ${n} near the bus stand on Market Road has not worked since last Monday, residents said. Unique detail ${n}-${Math.random()}.`,
          language: 'en',
          locationId: tree.village.id,
          categoryId: civic,
        })
        .expect(201)
    ).body.submission;
    return (await reporter.post(`/api/v1/submissions/${draft.id}/submit`, {}).expect(200)).body.submission;
  };
  const decide = async (id: string, outcome: 'publish' | 'reject', by: Client = editor) => {
    await by.post(`/api/v1/editorial/submissions/${id}/claim`, {}).expect(200);
    if (outcome === 'publish') await by.post(`/api/v1/editorial/submissions/${id}/publish`, { trustLabel: 'citizen_reviewed' }).expect(200);
    else await by.post(`/api/v1/editorial/submissions/${id}/reject`, { reasonCode: 'insufficient_evidence', note: 'No source could confirm this.' }).expect(200);
  };
  return { app, admin, editor, senior, senior2, veteran, newcomer, submit, decide };
}

describe('reporter track record', () => {
  it('is visible to the reporter, counts decisions, and gives trusted reporters a head start in the queue', async () => {
    const { editor, veteran, newcomer, submit, decide } = await setup();
    expect((await veteran.get('/api/v1/submissions/track-record').expect(200)).body.trackRecord).toMatchObject({ tier: 'new', published: 0, queueHeadStartHours: 0 });

    for (let i = 0; i < 5; i++) await decide((await submit(veteran)).id, 'publish');
    const record = (await veteran.get('/api/v1/submissions/track-record').expect(200)).body.trackRecord;
    expect(record).toMatchObject({ tier: 'trusted', published: 5, rejected: 0, windowDays: 180, queueHeadStartHours: 12 });

    const early = await submit(newcomer, 'Newcomer report sent first about the canal');
    const late = await submit(veteran, 'Veteran report sent later about the canal');
    const queue = (await editor.get('/api/v1/editorial/submissions?status=submitted').expect(200)).body.items;
    expect(queue.map((s: { id: string }) => s.id)).toEqual([late.id, early.id]);

    // Editors see the record on the submission; the reporter's own view does not include it.
    expect((await editor.get(`/api/v1/editorial/submissions/${late.id}`).expect(200)).body.submission.reporterTrackRecord).toMatchObject({ tier: 'trusted' });
    expect((await veteran.get(`/api/v1/submissions/${late.id}`).expect(200)).body.submission.reporterTrackRecord).toBeNull();
  });

  it('marks a reporter whose reports are mostly not published as needing support, without pushing them back', async () => {
    const { editor, veteran, newcomer, submit, decide } = await setup();
    for (let i = 0; i < 5; i++) await decide((await submit(newcomer)).id, 'reject');
    const record = (await newcomer.get('/api/v1/submissions/track-record').expect(200)).body.trackRecord;
    expect(record).toMatchObject({ tier: 'needs_support', rejected: 5, rejectedByReason: { insufficient_evidence: 5 }, queueHeadStartHours: 0 });

    const first = await submit(newcomer, 'Struggling reporter sends first');
    const second = await submit(veteran, 'New reporter sends second');
    const queue = (await editor.get('/api/v1/editorial/submissions?status=submitted').expect(200)).body.items;
    expect(queue.map((s: { id: string }) => s.id)).toEqual([first.id, second.id]); // plain first-come order
  });
});

describe('appeals', () => {
  it('lets a reporter appeal once; a different senior editor can overturn it, sending it back to review', async () => {
    const { editor, senior, senior2, newcomer, submit, decide } = await setup();
    const sub = await submit(newcomer);
    await decide(sub.id, 'reject', senior);

    const mine = (await newcomer.get(`/api/v1/submissions/${sub.id}`).expect(200)).body.submission;
    expect(mine.appealUntil).toEqual(expect.any(String));
    await newcomer.post(`/api/v1/submissions/${sub.id}/appeal`, { note: 'too short' }).expect(400);
    const appealed = (await newcomer.post(`/api/v1/submissions/${sub.id}/appeal`, { note: 'The panchayat notice confirms this; I have added a photo of it.' }).expect(201)).body.submission;
    expect(appealed).toMatchObject({ appeal: { status: 'open' }, appealUntil: null });
    await newcomer.post(`/api/v1/submissions/${sub.id}/appeal`, { note: 'Trying a second appeal on the same report.' }).expect(409);

    await editor.get('/api/v1/editorial/appeals').expect(403); // senior editors only
    const [appeal] = (await senior2.get('/api/v1/editorial/appeals').expect(200)).body.items;
    expect(appeal).toMatchObject({ status: 'open', submission: { id: sub.id, reasonCode: 'insufficient_evidence' }, reporter: { displayName: expect.any(String) } });

    // The editor who rejected it cannot decide the appeal.
    await senior.post(`/api/v1/editorial/appeals/${appeal.id}/decide`, { outcome: 'upheld', note: 'I still think so.' }).expect(403);
    await senior2.post(`/api/v1/editorial/appeals/${appeal.id}/decide`, { outcome: 'overturned', note: 'The notice is enough to review again.' }).expect(200);
    await senior2.post(`/api/v1/editorial/appeals/${appeal.id}/decide`, { outcome: 'upheld', note: 'Changing my mind.' }).expect(409);

    const after = (await newcomer.get(`/api/v1/submissions/${sub.id}`).expect(200)).body.submission;
    expect(after.status).toBe('submitted');
    expect(after.appeal).toMatchObject({ status: 'overturned', decisionNote: 'The notice is enough to review again.' });
    expect(after.timeline.map((e: { action: string }) => e.action).slice(-3)).toEqual(['rejected', 'appealed', 'appeal_overturned']);
    // An overturned rejection does not count against the reporter.
    expect((await newcomer.get('/api/v1/submissions/track-record').expect(200)).body.trackRecord).toMatchObject({ rejected: 0, appealsOverturned: 1 });
    expect(await AuditEventModel.countDocuments({ action: 'appeal.overturned' })).toBe(1);
  });

  it('an upheld appeal keeps the rejection, and appeals close after 14 days', async () => {
    const { senior, senior2, newcomer, submit, decide } = await setup();
    const a = await submit(newcomer);
    await decide(a.id, 'reject', senior);
    await newcomer.post(`/api/v1/submissions/${a.id}/appeal`, { note: 'Please look again; the facts are correct.' }).expect(201);
    const [appeal] = (await senior2.get('/api/v1/editorial/appeals').expect(200)).body.items;
    await senior2.post(`/api/v1/editorial/appeals/${appeal.id}/decide`, { outcome: 'upheld', note: 'Still no independent source.' }).expect(200);
    const after = (await newcomer.get(`/api/v1/submissions/${a.id}`).expect(200)).body.submission;
    expect(after).toMatchObject({ status: 'rejected', appeal: { status: 'upheld' } });
    expect(after.timeline.at(-1)).toMatchObject({ action: 'appeal_upheld', note: 'Still no independent source.' });

    const old = await submit(newcomer);
    await decide(old.id, 'reject', senior);
    await EditorialEventModel.updateMany({ submissionId: old.id, action: 'rejected' }, { $set: { at: new Date(Date.now() - 15 * 86_400_000) } });
    expect((await newcomer.get(`/api/v1/submissions/${old.id}`).expect(200)).body.submission.appealUntil).toBeNull();
    await newcomer.post(`/api/v1/submissions/${old.id}/appeal`, { note: 'Appealing well after the window closed.' }).expect(409);
  });
});

describe('admin operations', () => {
  it('shows a health summary, retries failed jobs, and is admin-only', async () => {
    const { admin, editor, newcomer, submit } = await setup();
    await submit(newcomer);
    const dead = await JobModel.create({ type: 'notify_new_article', payload: {}, status: 'dead', attempts: 6, lastError: 'boom' });

    await editor.get('/api/v1/admin/ops').expect(403);
    const ops = (await admin.get('/api/v1/admin/ops').expect(200)).body;
    expect(ops.users.byRole).toMatchObject({ admin: 1, reporter: 2, senior_editor: 2 });
    expect(ops.newsroom.byStatus).toMatchObject({ submitted: 1 });
    expect(ops.newsroom.oldestWaitingHours).toBe(0);
    expect(ops.jobs.problems).toEqual([expect.objectContaining({ id: dead.id, status: 'dead', lastError: 'boom' })]);
    expect(ops.ai.configured).toBe(false);

    await admin.post(`/api/v1/admin/jobs/${dead.id}/retry`, {}).expect(200);
    expect(await JobModel.findById(dead.id).lean()).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    await admin.post(`/api/v1/admin/jobs/${dead.id}/retry`, {}).expect(409);
  });

  it('lists the audit log newest first, filtered by action or prefix, with paging', async () => {
    const { admin, editor, newcomer, submit } = await setup();
    await submit(newcomer);
    await submit(newcomer);
    await editor.get('/api/v1/admin/audit').expect(403);

    const subs = (await admin.get('/api/v1/admin/audit?action=submission.submitted&limit=1').expect(200)).body;
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0]).toMatchObject({ action: 'submission.submitted', actor: { email: 'newcomer@example.in' }, targetType: 'submission' });
    const next = (await admin.get(`/api/v1/admin/audit?action=submission.submitted&limit=1&cursor=${subs.nextCursor}`).expect(200)).body;
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(subs.items[0].id);

    const prefix = (await admin.get('/api/v1/admin/audit?action=submission.').expect(200)).body.items;
    expect(prefix.length).toBeGreaterThanOrEqual(2);
    expect(prefix.every((i: { action: string }) => i.action.startsWith('submission.'))).toBe(true);
    await admin.get('/api/v1/admin/audit?action=$where').expect(400);
  });
});
