import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../src/modules/audit/audit';
import { ArticleRevisionModel } from '../src/modules/publishing/article.model';
import { articleBody, categoryId, createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

async function setup() {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const education = await categoryId(editor, 'education');
  const publish = async (locationId: string, overrides: Record<string, unknown> = {}, catId = civic) =>
    (await editor.post('/api/v1/editorial/articles', articleBody(locationId, catId, overrides)).expect(201)).body.article;
  return { app, admin, editor, tree, civic, education, publish, anon: client(app) };
}

describe('publishing (AC3, AC4)', () => {
  it('editors publish; the public page shows source, trust label and the initial revision', async () => {
    const { anon, tree, publish } = await setup();
    const article = await publish(tree.village.id);
    expect(article.slug).toMatch(/^road-repairs-start-in-alpha-village-[a-f0-9]{8}$/);

    const res = await anon.get(`/api/v1/articles/${article.slug}`).expect(200);
    expect(res.body.article).toMatchObject({
      status: 'published',
      headline: 'Road repairs start in Alpha Village',
      trustLabel: 'editor_verified',
      sourceType: 'staff',
      location: { label: 'Alpha Village, Alpha Mandal, Test District' },
      category: { slug: 'civic_issues' },
      correctionCount: 0,
      history: [{ revisionNumber: 1, changeKind: 'initial', publicNote: null }],
    });
  });

  it('readers and reporters cannot publish', async () => {
    const { app, tree, civic } = await setup();
    const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
    const reporter = await userWithRoles(app, 'reporter@example.in', ['reader', 'reporter']);
    await reader.post('/api/v1/editorial/articles', articleBody(tree.village.id, civic)).expect(403);
    await reporter.post('/api/v1/editorial/articles', articleBody(tree.village.id, civic)).expect(403);
    await client(app).post('/api/v1/editorial/articles', articleBody(tree.village.id, civic)).expect(401);
  });

  it('Telugu headlines get a usable slug', async () => {
    const { tree, publish } = await setup();
    const article = await publish(tree.village.id, { headline: 'ఆల్ఫా గ్రామంలో రోడ్డు మరమ్మతులు', language: 'te' });
    expect(article.slug).toMatch(/^news-[a-f0-9]{8}$/);
  });

  it('official announcements must link to the original source; unknown locations are rejected', async () => {
    const { editor, tree, civic } = await setup();
    const res = await editor
      .post('/api/v1/editorial/articles', articleBody(tree.district.id, civic, { sourceType: 'official_publisher', trustLabel: 'official_unverified' }))
      .expect(400);
    expect(res.body.error.details[0].path).toBe('originalSourceUrl');
    await editor.post('/api/v1/editorial/articles', articleBody('0123456789abcdef01234567', civic)).expect(400);
  });

  it('corrections create an immutable revision with a public note and count as corrections', async () => {
    const { editor, anon, tree, publish } = await setup();
    const article = await publish(tree.village.id);
    await editor
      .post(`/api/v1/editorial/articles/${article.id}/revisions`, { changeKind: 'correction', summary: 'Repairs will take three weeks, not two.' })
      .expect(400); // a correction needs a public note
    await editor
      .post(`/api/v1/editorial/articles/${article.id}/revisions`, {
        changeKind: 'correction',
        summary: 'The main road will be repaired over the next three weeks.',
        publicNote: 'The repair period is three weeks, not two.',
      })
      .expect(200);
    await editor.post(`/api/v1/editorial/articles/${article.id}/revisions`, { changeKind: 'update', body: 'Repairs began on Monday as planned. Diversions are in place on the market road.' }).expect(200);

    const res = await anon.get(`/api/v1/articles/${article.slug}`).expect(200);
    expect(res.body.article.summary).toBe('The main road will be repaired over the next three weeks.');
    expect(res.body.article.correctionCount).toBe(1);
    expect(res.body.article.history.map((h: { changeKind: string }) => h.changeKind)).toEqual(['initial', 'correction', 'update']);
    expect(res.body.article.history[1].publicNote).toBe('The repair period is three weeks, not two.');
    // The original wording is preserved in revision 1.
    const first = await ArticleRevisionModel.findOne({ articleId: article.id, revisionNumber: 1 }).lean();
    expect(first?.summary).toBe('The main road will be repaired over the next two weeks.');
  });
});

describe('unpublish and retract (AC5)', () => {
  it('unpublished articles disappear from the public page, feed and search; republishing restores them', async () => {
    const { editor, anon, tree, publish } = await setup();
    const article = await publish(tree.village.id);
    await editor.post(`/api/v1/editorial/articles/${article.id}/unpublish`, { reason: 'Legal review requested' }).expect(200);

    await anon.get(`/api/v1/articles/${article.slug}`).expect(404);
    expect((await anon.get('/api/v1/articles').expect(200)).body.items).toHaveLength(0);
    expect((await anon.get('/api/v1/articles/search?q=repairs').expect(200)).body.items).toHaveLength(0);
    const event = await AuditEventModel.findOne({ action: 'article.unpublished' }).lean();
    expect(event?.metadata).toEqual({ reason: 'Legal review requested' });

    await editor.post(`/api/v1/editorial/articles/${article.id}/republish`).expect(200);
    await anon.get(`/api/v1/articles/${article.slug}`).expect(200);
  });

  it('retraction needs a senior editor; the page keeps the notice but withdraws the text', async () => {
    const { app, editor, anon, tree, publish } = await setup();
    const article = await publish(tree.village.id);
    await editor.post(`/api/v1/editorial/articles/${article.id}/retract`, { publicNote: 'The report could not be confirmed.' }).expect(403);

    const senior = await userWithRoles(app, 'senior@example.in', ['reader', 'senior_editor']);
    await senior.post(`/api/v1/editorial/articles/${article.id}/retract`, { publicNote: 'The report could not be confirmed.' }).expect(200);

    const res = await anon.get(`/api/v1/articles/${article.slug}`).expect(200);
    expect(res.body.article).toMatchObject({ status: 'retracted', body: null });
    expect(res.body.article.history.at(-1)).toMatchObject({ changeKind: 'retraction', publicNote: 'The report could not be confirmed.' });
    expect((await anon.get('/api/v1/articles').expect(200)).body.items).toHaveLength(0);
    await senior.post(`/api/v1/editorial/articles/${article.id}/revisions`, { changeKind: 'update', headline: 'Trying to edit after retraction' }).expect(409);
  });

  it('editors see unpublished articles in their own list', async () => {
    const { editor, tree, publish } = await setup();
    const a = await publish(tree.village.id);
    await publish(tree.mandalB.id, { headline: 'Second story in Beta Mandal' });
    await editor.post(`/api/v1/editorial/articles/${a.id}/unpublish`, { reason: 'Checking facts again' }).expect(200);
    const res = await editor.get('/api/v1/editorial/articles?status=unpublished').expect(200);
    expect(res.body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });
});

describe('feeds (AC6, AC7)', () => {
  it('a district feed includes news from inside it; a village feed includes news from above it', async () => {
    const { anon, tree, publish } = await setup();
    const villageNews = await publish(tree.village.id, { headline: 'Village news item one' });
    const otherMandalNews = await publish(tree.mandalB.id, { headline: 'Beta mandal news item' });
    const districtNews = await publish(tree.district.id, { headline: 'District wide holiday announced' });

    const ids = async (locationId: string) =>
      (await anon.get(`/api/v1/articles?locationId=${locationId}`).expect(200)).body.items.map((a: { id: string }) => a.id);
    expect(await ids(tree.district.id)).toEqual([districtNews.id, otherMandalNews.id, villageNews.id]);
    expect(await ids(tree.village.id)).toEqual([districtNews.id, villageNews.id]);
    expect(await ids(tree.mandalB.id)).toEqual([districtNews.id, otherMandalNews.id]);
  });

  it('filters by category', async () => {
    const { anon, tree, publish, education } = await setup();
    await publish(tree.village.id);
    const school = await publish(tree.village.id, { headline: 'New school building opened' }, education);
    const res = await anon.get(`/api/v1/articles?categoryId=${education}`).expect(200);
    expect(res.body.items.map((a: { id: string }) => a.id)).toEqual([school.id]);
  });

  it('keyset pagination has no duplicates or gaps even when new articles arrive mid-scroll', async () => {
    const { anon, tree, publish } = await setup();
    const published = [];
    for (let i = 0; i < 5; i++) published.push((await publish(tree.village.id, { headline: `Story number ${i} in the village` })).id);
    const page1 = (await anon.get('/api/v1/articles?limit=2').expect(200)).body;
    await publish(tree.village.id, { headline: 'Breaking story published while scrolling' });
    const page2 = (await anon.get(`/api/v1/articles?limit=2&cursor=${page1.nextCursor}`).expect(200)).body;
    const page3 = (await anon.get(`/api/v1/articles?limit=2&cursor=${page2.nextCursor}`).expect(200)).body;
    const seen = [...page1.items, ...page2.items, ...page3.items].map((a: { id: string }) => a.id);
    expect(seen).toEqual([...published].reverse());
    expect(page3.nextCursor).toBeNull();
    await anon.get('/api/v1/articles?cursor=not-a-cursor').expect(400);
  });
});

describe('search (AC9)', () => {
  it('finds published articles by headline or summary words, in English and Telugu', async () => {
    const { anon, tree, publish } = await setup();
    const road = await publish(tree.village.id);
    const te = await publish(tree.village.id, {
      headline: 'గ్రామంలో కొత్త పాఠశాల భవనం',
      summary: 'పాఠశాల భవనాన్ని ఈ రోజు ప్రారంభించారు.',
      language: 'te',
    });
    const find = async (q: string) =>
      (await anon.get(`/api/v1/articles/search?q=${encodeURIComponent(q)}`).expect(200)).body.items.map((a: { id: string }) => a.id);
    expect(await find('repaired')).toEqual([road.id]);
    expect(await find('పాఠశాల')).toEqual([te.id]);
    expect(await find('nothing-matches-this')).toEqual([]);
  });
});
