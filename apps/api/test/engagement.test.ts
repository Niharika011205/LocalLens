import { describe, expect, it } from 'vitest';
import { articleBody, categoryId, createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

async function setup() {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const education = await categoryId(editor, 'education');
  const publish = async (locationId: string, headline: string, catId = civic) =>
    (await editor.post('/api/v1/editorial/articles', articleBody(locationId, catId, { headline })).expect(201)).body.article;
  return { app, editor, reader, tree, civic, education, publish };
}

describe('follows and personalised feed (AC8)', () => {
  it('following a village shows its news and the news above it; following a category adds that topic', async () => {
    const { reader, tree, education, publish } = await setup();
    const village = await publish(tree.village.id, 'News from Alpha Village');
    const district = await publish(tree.district.id, 'District wide notice');
    await publish(tree.mandalB.id, 'Unrelated Beta Mandal news');
    const school = await publish(tree.mandalB.id, 'School exam dates in Beta Mandal', education);

    await reader.get('/api/v1/me/feed').expect(200, { items: [], nextCursor: null });
    await reader.put(`/api/v1/me/follows/location/${tree.village.id}`, {}).expect(204);
    await reader.put(`/api/v1/me/follows/location/${tree.village.id}`, {}).expect(204); // idempotent
    await reader.put(`/api/v1/me/follows/category/${education}`, {}).expect(204);

    const follows = await reader.get('/api/v1/me/follows').expect(200);
    expect(follows.body.locations.map((l: { id: string }) => l.id)).toEqual([tree.village.id]);
    expect(follows.body.categories.map((c: { slug: string }) => c.slug)).toEqual(['education']);

    const feed = await reader.get('/api/v1/me/feed').expect(200);
    expect(feed.body.items.map((a: { id: string }) => a.id)).toEqual([school.id, district.id, village.id]);

    await reader.agent.delete(`/api/v1/me/follows/category/${education}`).set('Origin', 'http://localhost:5180').expect(204);
    const after = await reader.get('/api/v1/me/feed').expect(200);
    expect(after.body.items.map((a: { id: string }) => a.id)).toEqual([district.id, village.id]);
  });

  it('rejects unknown targets and requires sign-in', async () => {
    const { app, reader } = await setup();
    await reader.put('/api/v1/me/follows/location/0123456789abcdef01234567', {}).expect(404);
    await reader.put('/api/v1/me/follows/planet/0123456789abcdef01234567', {}).expect(400);
    await client(app).get('/api/v1/me/feed').expect(401);
  });
});

describe('saved articles (AC8)', () => {
  it('saves, lists newest first, and drops articles that are later unpublished', async () => {
    const { reader, editor, tree, publish } = await setup();
    const a = await publish(tree.village.id, 'First saved story here');
    const b = await publish(tree.village.id, 'Second saved story here');
    await reader.put(`/api/v1/me/saved/${a.id}`, {}).expect(204);
    await reader.put(`/api/v1/me/saved/${b.id}`, {}).expect(204);
    expect((await reader.get(`/api/v1/me/saved/${a.id}`).expect(200)).body).toEqual({ saved: true });

    const list = await reader.get('/api/v1/me/saved').expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);

    await editor.post(`/api/v1/editorial/articles/${b.id}/unpublish`, { reason: 'Checking the facts' }).expect(200);
    const after = await reader.get('/api/v1/me/saved').expect(200);
    expect(after.body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);

    await reader.agent.delete(`/api/v1/me/saved/${a.id}`).set('Origin', 'http://localhost:5180').expect(204);
    expect((await reader.get(`/api/v1/me/saved/${a.id}`).expect(200)).body).toEqual({ saved: false });
  });

  it('cannot save an unpublished article', async () => {
    const { reader, editor, tree, publish } = await setup();
    const a = await publish(tree.village.id, 'Story to be unpublished');
    await editor.post(`/api/v1/editorial/articles/${a.id}/unpublish`, { reason: 'Checking the facts' }).expect(200);
    await reader.put(`/api/v1/me/saved/${a.id}`, {}).expect(404);
  });
});
