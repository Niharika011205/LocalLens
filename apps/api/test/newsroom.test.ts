import { describe, expect, it } from 'vitest';
import { jaccard, wordSet } from '../src/modules/newsroom/duplicates';
import { screenRisk } from '../src/modules/newsroom/risk';
import { SubmissionVersionModel } from '../src/modules/newsroom/submission.model';
import { categoryId, createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

async function setup() {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const senior = await userWithRoles(app, 'senior@example.in', ['reader', 'senior_editor']);
  const reporter = await userWithRoles(app, 'reporter@example.in', ['reader', 'reporter']);
  const other = await userWithRoles(app, 'other@example.in', ['reader', 'reporter']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const story = (overrides: Record<string, unknown> = {}) => ({
    headline: 'Street lights not working on Market Road',
    summary: 'Residents say the street lights have been off for a week.',
    body: 'All twelve street lights on Market Road have been off since last Monday. Shop owners have complained twice.',
    language: 'en',
    locationId: tree.village.id,
    categoryId: civic,
    incidentDate: '2026-10-20',
    supportingUrls: ['https://example.org/photo-of-dark-road'],
    editorContext: 'I live on this road and can share photos.',
    ...overrides,
  });
  const draftAndSubmit = async (c = reporter, overrides: Record<string, unknown> = {}) => {
    const draft = (await c.post('/api/v1/submissions', story(overrides)).expect(201)).body.submission;
    return (await c.post(`/api/v1/submissions/${draft.id}/submit`, {}).expect(200)).body.submission;
  };
  return { app, admin, editor, senior, reporter, other, tree, civic, story, draftAndSubmit };
}

describe('reporter submissions', () => {
  it('only reporters (and publishers) can submit', async () => {
    const { app, story } = await setup();
    const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
    await reader.post('/api/v1/submissions', story()).expect(403);
    await client(app).post('/api/v1/submissions', story()).expect(401);
  });

  it('drafts can be incomplete; submitting checks completeness and snapshots a version', async () => {
    const { reporter, tree } = await setup();
    const draft = (await reporter.post('/api/v1/submissions', { headline: 'Half-written idea' }).expect(201)).body.submission;
    expect(draft.status).toBe('draft');
    const incomplete = await reporter.post(`/api/v1/submissions/${draft.id}/submit`, {}).expect(400);
    expect(incomplete.body.error.details.map((d: { path: string }) => d.path)).toEqual(['summary', 'body', 'locationId', 'categoryId']);

    await reporter.patch(`/api/v1/submissions/${draft.id}`, {
      summary: 'A longer summary of the situation.',
      body: 'Enough detail about what happened to pass the check.',
      locationId: tree.village.id,
      categoryId: (await reporter.get('/api/v1/categories')).body.items[0].id,
    }).expect(200);
    const submitted = (await reporter.post(`/api/v1/submissions/${draft.id}/submit`, {}).expect(200)).body.submission;
    expect(submitted).toMatchObject({ status: 'submitted', version: 1 });
    expect(await SubmissionVersionModel.countDocuments({ submissionId: draft.id })).toBe(1);
    await reporter.patch(`/api/v1/submissions/${draft.id}`, { headline: 'Too late to edit' }).expect(409);
  });

  it("a reporter cannot see or change someone else's submission (IDOR)", async () => {
    const { reporter, other, draftAndSubmit } = await setup();
    const sub = await draftAndSubmit(reporter);
    await other.get(`/api/v1/submissions/${sub.id}`).expect(404);
    await other.patch(`/api/v1/submissions/${sub.id}`, { headline: 'Hijacked headline' }).expect(404);
    await other.post(`/api/v1/submissions/${sub.id}/withdraw`, {}).expect(404);
    expect((await other.get('/api/v1/submissions').expect(200)).body.items).toHaveLength(0);
  });

  it('reporters can withdraw before a decision', async () => {
    const { reporter, draftAndSubmit } = await setup();
    const sub = await draftAndSubmit();
    const res = await reporter.post(`/api/v1/submissions/${sub.id}/withdraw`, {}).expect(200);
    expect(res.body.submission.status).toBe('withdrawn');
  });
});

describe('editorial review', () => {
  it('queue → review → request info → reporter responds → publish creates a citizen article', async () => {
    const { editor, reporter, draftAndSubmit } = await setup();
    const sub = await draftAndSubmit();

    const queue = await editor.get('/api/v1/editorial/submissions').expect(200);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toEqual([sub.id]);

    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/request-info`, { note: 'Please add when you first noticed it.' }).expect(200);

    const mine = (await reporter.get(`/api/v1/submissions/${sub.id}`).expect(200)).body.submission;
    expect(mine.status).toBe('needs_info');
    expect(mine.timeline.map((e: { action: string }) => e.action)).toEqual(['created', 'submitted', 'review_started', 'info_requested']);
    expect(mine.timeline[3]).toMatchObject({ note: 'Please add when you first noticed it.', actorRole: 'editor' });
    expect(mine.reporter).toBeNull(); // reporters never see editor identities

    await reporter.patch(`/api/v1/submissions/${sub.id}`, { body: 'The lights went off on Monday 19 October at about 7 pm. All twelve are still off.' }).expect(200);
    const again = (await reporter.post(`/api/v1/submissions/${sub.id}/submit`, { responseNote: 'Added the date.' }).expect(200)).body.submission;
    expect(again).toMatchObject({ status: 'submitted', version: 2 });

    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    const published = (await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'citizen_reviewed' }).expect(200)).body.submission;
    expect(published.status).toBe('published');
    expect(published.article).toMatchObject({ sourceType: 'citizen', trustLabel: 'citizen_reviewed', headline: 'Street lights not working on Market Road' });

    await editor.get(`/api/v1/articles/${published.article.slug}`).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'citizen_reviewed' }).expect(409);
  });

  it('rejection gives the reporter a reason code and note; drafts never reach editors', async () => {
    const { editor, reporter, story, draftAndSubmit } = await setup();
    const draft = (await reporter.post('/api/v1/submissions', story()).expect(201)).body.submission;
    await editor.get(`/api/v1/editorial/submissions/${draft.id}`).expect(404);

    const sub = await draftAndSubmit();
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/reject`, { reasonCode: 'not_news', note: 'Not ready' }).expect(409); // not claimed yet
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/reject`, { reasonCode: 'insufficient_evidence', note: 'We could not confirm this with residents.' }).expect(200);
    const mine = (await reporter.get(`/api/v1/submissions/${sub.id}`).expect(200)).body.submission;
    expect(mine.status).toBe('rejected');
    expect(mine.timeline.at(-1)).toMatchObject({ reasonCode: 'insufficient_evidence', note: 'We could not confirm this with residents.' });
  });

  it('citizen reports cannot be labelled as official', async () => {
    const { editor, draftAndSubmit } = await setup();
    const sub = await draftAndSubmit();
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'official_unverified' }).expect(400);
  });
});

describe('high-risk content', () => {
  it('is flagged automatically and must be published by a senior editor', async () => {
    const { editor, senior, reporter, draftAndSubmit } = await setup();
    const sub = await draftAndSubmit(reporter, { headline: 'Panchayat clerk arrested for taking bribe', summary: 'Police say the clerk accepted a bribe for a certificate.' });
    expect(sub.riskLevel).toBe('high');
    expect(sub.riskReasons).toEqual([]); // reasons are for editors only

    const forEditor = (await editor.get(`/api/v1/editorial/submissions/${sub.id}`).expect(200)).body.submission;
    expect(forEditor.riskReasons).toEqual(['allegation_or_crime']);

    await editor.post(`/api/v1/editorial/submissions/${sub.id}/claim`, {}).expect(200);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'editor_verified' }).expect(403);
    await editor.post(`/api/v1/editorial/submissions/${sub.id}/risk`, { riskLevel: 'normal', note: 'Looks fine to me' }).expect(403);
    await senior.post(`/api/v1/editorial/submissions/${sub.id}/publish`, { trustLabel: 'editor_verified' }).expect(200);
  });

  it('high-risk items come first in the queue', async () => {
    const { editor, draftAndSubmit } = await setup();
    const normal = await draftAndSubmit();
    const risky = await draftAndSubmit(undefined, { headline: 'Flood water enters houses near canal', summary: 'Several families moved after flood water entered homes.' });
    const queue = (await editor.get('/api/v1/editorial/submissions').expect(200)).body.items.map((i: { id: string }) => i.id);
    expect(queue).toEqual([risky.id, normal.id]);
  });

  it('screens Telugu with substrings and English with whole words', () => {
    expect(screenRisk('గ్రామంలో వరద నీరు', null)).toEqual({ level: 'high', reasons: ['disaster'] });
    expect(screenRisk('పోలీసులు అరెస్టు చేశారు', null).reasons).toEqual(['allegation_or_crime']);
    expect(screenRisk('New firewall for the school computers', null).level).toBe('normal');
    expect(screenRisk('Road repaired', 'public_safety').reasons).toEqual(['public_safety']);
  });
});

describe('duplicates and scopes', () => {
  it('links near-identical reports from the same district', async () => {
    const { editor, other, draftAndSubmit } = await setup();
    const a = await draftAndSubmit();
    await draftAndSubmit(other, { headline: 'Street lights not working on the Market Road' });
    const forEditor = (await editor.get(`/api/v1/editorial/submissions/${a.id}`).expect(200)).body.submission;
    expect(forEditor.possibleDuplicateIds).toHaveLength(1);
    expect(jaccard(wordSet('Water supply cut in Alpha'), wordSet('Water supply cut in Alpha village'))).toBeGreaterThan(0.45);
  });

  it('a scoped editor only sees submissions inside their places', async () => {
    const { app, admin, tree, draftAndSubmit } = await setup();
    const scoped = await userWithRoles(app, 'scoped@example.in', ['reader', 'editor']);
    const scopedUser = (await admin.get('/api/v1/admin/users?q=scoped').expect(200)).body.items[0];
    await admin.put(`/api/v1/admin/users/${scopedUser.id}/scopes`, { locationIds: [tree.mandalB.id] }).expect(200);

    const inAlpha = await draftAndSubmit();
    expect((await scoped.get('/api/v1/editorial/submissions').expect(200)).body.items).toHaveLength(0);
    await scoped.get(`/api/v1/editorial/submissions/${inAlpha.id}`).expect(404);
    await scoped.post(`/api/v1/editorial/submissions/${inAlpha.id}/claim`, {}).expect(404);
  });
});
