import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createRateLimiters, DEFAULT_LIMITS } from '../src/middleware/rate-limit';
import { AuditEventModel } from '../src/modules/audit/audit';
import { UserModel } from '../src/modules/identity/models';
import { ContentReportModel } from '../src/modules/moderation/reports';
import { articleBody, categoryId, createTree } from './fixtures';
import { buildApp, client, ORIGIN, signUp, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

type Client = ReturnType<typeof client>;

/** A real JPEG with camera metadata we can look for afterwards (stands in for a phone's GPS data). */
const jpegWithMetadata = (width = 3000, height = 2000) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .withExif({ IFD0: { Artist: 'SECRET-OWNER-NAME', Copyright: 'GPS 16.3067N 80.4365E' } })
    .jpeg()
    .toBuffer();

async function setup(overrides: Record<string, string> = {}) {
  // Many readers sign up from one test "IP", so the sign-up limit is raised here (it is tested in security.test.ts).
  const limiters = createRateLimiters({ kind: 'memory' }, { ...DEFAULT_LIMITS, register: { points: 100, duration: 3600 } });
  const { app } = buildApp({ limiters, config: testConfig({ REPORTER_SELF_SIGNUP: 'true', REPORTS_TO_REMOVE: '10', ...overrides }) });
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const { c: reporter } = await signUp(app, 'reporter@example.in', { requestReporter: true });
  const post = (c: Client, fields: Record<string, string> = {}, photo?: Buffer, photoType = 'image/jpeg') => {
    const req = c.agent
      .post('/api/v1/posts')
      .set('Origin', ORIGIN)
      .field({
        headline: 'Drinking water tank cleaned in Alpha Village',
        summary: 'The panchayat cleaned the overhead water tank today. Supply resumes at 6 am tomorrow.',
        language: 'en',
        locationId: tree.village.id,
        categoryId: civic,
        ...fields,
      });
    return photo ? req.attach('photo', photo, { filename: 'photo.jpg', contentType: photoType }) : req;
  };
  const readers = async (n: number) => {
    const out: Client[] = [];
    for (let i = 0; i < n; i++) out.push((await signUp(app, `reader${i}@example.in`)).c);
    return out;
  };
  return { app, admin, editor, reporter, tree, civic, post, readers };
}

describe('quick posts', () => {
  it('anyone who signs up to post news can post at once; it goes live with a clear label and a cleaned photo', async () => {
    const { app, reporter, post } = await setup();
    expect((await reporter.get('/api/v1/auth/me').expect(200)).body.user.roles).toEqual(['reader', 'reporter']);

    const res = await post(reporter, {}, await jpegWithMetadata()).expect(201);
    expect(res.body.post).toMatchObject({ status: 'published', trustLabel: 'reporter_post', sourceType: 'citizen', holdReason: null, openReports: 0 });
    expect(res.body.post.imageUrl).toMatch(/^\/api\/v1\/media\/[a-f0-9]{24}$/);

    const feed = (await client(app).get('/api/v1/articles').expect(200)).body.items;
    expect(feed[0]).toMatchObject({ headline: 'Drinking water tank cleaned in Alpha Village', imageUrl: res.body.post.imageUrl });

    // The photo: served publicly, re-encoded, shrunk for phones, and stripped of all metadata.
    const img = await client(app).get(res.body.post.imageUrl).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(img.headers['content-type']).toBe('image/webp');
    const meta = await sharp(img.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1280);
    expect(meta.exif).toBeUndefined();
    expect((img.body as Buffer).toString('latin1')).not.toContain('SECRET-OWNER-NAME');

    // A post without a photo is fine too; the full text defaults to the short summary.
    const noPhoto = (await post(reporter, { headline: 'Ration shop open on Sunday this week' }).expect(201)).body.post;
    expect(noPhoto.imageUrl).toBeNull();
    expect((await client(app).get(`/api/v1/articles/${noPhoto.slug}`).expect(200)).body.article.body).toContain('panchayat cleaned');
  });

  it('rejects files that are not photos, oversized photos, and readers who are not reporters', async () => {
    const { app, post } = await setup();
    const { c: reporter } = await signUp(app, 'r2@example.in', { requestReporter: true });
    const fake = Buffer.from('<?php echo "not a picture"; ?>');
    expect((await post(reporter, {}, fake).expect(400)).body.error.details[0].path).toBe('photo');
    await post(reporter, {}, fake, 'text/html').expect(400);
    await post(reporter, {}, Buffer.alloc(9 * 1024 * 1024, 1)).expect(413);
    await post(reporter, { summary: 'x'.repeat(561) }).expect(400);

    const { c: reader } = await signUp(app, 'plain-reader@example.in');
    await post(reader).expect(403);
    // Multipart is accepted only on the posting route.
    await reader.agent.post('/api/v1/me/reporter-request').set('Origin', ORIGIN).field('x', 'y').expect(415);
  });

  it('removes a post automatically once 10 different readers report it; the author is told why', async () => {
    const { app, editor, reporter, tree, civic, post, readers } = await setup();
    const p = (await post(reporter, {}, await jpegWithMetadata(400, 300)).expect(201)).body.post;
    const crowd = await readers(10);

    await reporter.post(`/api/v1/articles/${p.id}/reports`, { reason: 'spam' }).expect(409); // not your own post
    for (const [i, r] of crowd.slice(0, 9).entries()) {
      const res = await r.post(`/api/v1/articles/${p.id}/reports`, { reason: i % 2 ? 'spam' : 'false_information' }).expect(201);
      expect(res.body.removed).toBe(false);
    }
    await crowd[0]!.post(`/api/v1/articles/${p.id}/reports`, { reason: 'spam' }).expect(409); // one report per person
    expect((await client(app).get('/api/v1/articles').expect(200)).body.items.map((a: { id: string }) => a.id)).toContain(p.id);

    const tenth = await crowd[9]!.post(`/api/v1/articles/${p.id}/reports`, { reason: 'spam' }).expect(201);
    expect(tenth.body).toMatchObject({ removed: true });
    expect((await client(app).get('/api/v1/articles').expect(200)).body.items.map((a: { id: string }) => a.id)).not.toContain(p.id);
    await client(app).get(`/api/v1/articles/${p.slug}`).expect(404);
    await client(app).get(p.imageUrl).expect(404); // the photo goes too
    await reporter.get(p.imageUrl).expect(200); // ...but the author can still see what was removed

    const mine = (await reporter.get('/api/v1/posts/mine').expect(200)).body;
    expect(mine).toMatchObject({ removeAfterReports: 10, items: [expect.objectContaining({ id: p.id, holdReason: 'community_reports', openReports: 10 })] });
    expect(await AuditEventModel.countDocuments({ action: 'post.auto_removed', targetId: p.id })).toBe(1);

    // Editor-checked articles are never removed by report counts; they go to editors.
    const checked = (await editor.post('/api/v1/editorial/articles', articleBody(tree.village.id, civic)).expect(201)).body.article;
    for (const r of crowd) expect((await r.post(`/api/v1/articles/${checked.id}/reports`, { reason: 'spam' }).expect(201)).body.removed).toBe(false);
    await client(app).get(`/api/v1/articles/${checked.slug}`).expect(200);
  });

  it('an editor can restore a post removed by unfair reports; old reports then stop counting', async () => {
    const { app, editor, reporter, post, readers } = await setup({ REPORTS_TO_REMOVE: '3' });
    const p = (await post(reporter).expect(201)).body.post;
    const crowd = await readers(4);
    for (const r of crowd.slice(0, 3)) await r.post(`/api/v1/articles/${p.id}/reports`, { reason: 'spam' }).expect(201);

    const [held] = (await editor.get('/api/v1/moderation/posts?reason=community_reports').expect(200)).body.items;
    expect(held).toMatchObject({ id: p.id, author: { displayName: 'Test User' }, reportReasons: { spam: 3 } });
    await editor.post(`/api/v1/moderation/posts/${p.id}/decide`, { decision: 'restore', note: 'Checked with the panchayat: true.' }).expect(200);
    await client(app).get(`/api/v1/articles/${p.slug}`).expect(200);
    expect(await ContentReportModel.countDocuments({ articleId: p.id, status: 'dismissed' })).toBe(3);

    // One new report is not enough to remove it again.
    expect((await crowd[3]!.post(`/api/v1/articles/${p.id}/reports`, { reason: 'spam' }).expect(201)).body.removed).toBe(false);
  });

  it('publishes sensitive posts at once too (only reports remove posts); nothing waits for an editor', async () => {
    const { app, editor, reporter, post } = await setup();
    const p = (await post(reporter, { headline: 'Communal clash reported near the market', summary: 'Residents say a communal clash broke out near the market this evening.' }).expect(201)).body.post;
    expect(p).toMatchObject({ status: 'published', holdReason: null });
    await client(app).get(`/api/v1/articles/${p.slug}`).expect(200);
    expect((await editor.get('/api/v1/moderation/posts?reason=needs_review').expect(200)).body.items).toEqual([]);
    await reporter.get('/api/v1/moderation/posts').expect(403);
  });

  it('authors can delete their own posts, nobody else\'s', async () => {
    const { app, reporter, post } = await setup();
    const p = (await post(reporter).expect(201)).body.post;
    const { c: other } = await signUp(app, 'other-reporter@example.in', { requestReporter: true });
    await other.del(`/api/v1/posts/${p.id}`).expect(404);
    await reporter.del(`/api/v1/posts/${p.id}`).expect(204);
    await client(app).get(`/api/v1/articles/${p.slug}`).expect(404);
    expect((await reporter.get('/api/v1/posts/mine').expect(200)).body.items[0].holdReason).toBe('author_deleted');
  });

  it('when self sign-up is off, posting needs an admin to approve reporter access', async () => {
    const { app } = buildApp({ config: testConfig({ REPORTER_SELF_SIGNUP: 'false' }) });
    await signUp(app, 'wannabe@example.in', { requestReporter: true });
    expect((await UserModel.findOne({ email: 'wannabe@example.in' }).lean())).toMatchObject({ roles: ['reader'], reporterRequest: { status: 'pending' } });
  });
});
