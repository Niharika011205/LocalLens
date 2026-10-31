import { describe, expect, it } from 'vitest';
import { isOfficialUrl } from '../src/modules/newsroom/publishers';
import { categoryId, createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

const DOMAIN = 'district.example.in';

async function setup(orgStatus: 'active' | 'onboarding' = 'active') {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const publisher = await userWithRoles(app, 'office@example.in', ['reader', 'publisher']);
  const tree = await createTree(admin);
  const gov = await categoryId(admin, 'government_announcements');
  const civic = await categoryId(admin, 'civic_issues');
  const org = (
    await admin
      .post('/api/v1/admin/publishers', {
        name: 'Test District Collectorate',
        status: orgStatus,
        jurisdictionIds: [tree.district.id],
        allowedCategoryIds: [gov],
        officialDomains: [DOMAIN],
      })
      .expect(201)
  ).body.org;
  const pubUser = (await admin.get('/api/v1/admin/users?q=office').expect(200)).body.items[0];
  await admin.put(`/api/v1/admin/users/${pubUser.id}/publisher`, { orgId: org.id }).expect(200);
  const announcement = (overrides: Record<string, unknown> = {}) => ({
    headline: 'Pension applications open until 15 November',
    summary: 'Eligible residents can apply at the village secretariat.',
    body: 'Applications for the old-age pension scheme are open. Bring an Aadhaar card and a bank passbook.',
    language: 'en',
    locationId: tree.mandalA.id,
    categoryId: gov,
    originalSourceUrl: `https://${DOMAIN}/notices/pension-2026.pdf`,
    deadline: '2026-11-15',
    ...overrides,
  });
  return { app, admin, editor, publisher, tree, gov, civic, org, announcement };
}

describe('publisher policy', () => {
  it('publishes directly when every check passes, labelled official and unverified, with its deadline', async () => {
    const { app, publisher, announcement } = await setup();
    const res = await publisher.post('/api/v1/publisher/announcements', announcement()).expect(201);
    expect(res.body.outcome).toBe('published');
    expect(res.body.article).toMatchObject({ trustLabel: 'official_unverified', sourceType: 'official_publisher', deadline: '2026-11-15' });
    const page = await client(app).get(`/api/v1/articles/${res.body.article.slug}`).expect(200);
    expect(page.body.article.originalSourceUrl).toBe(`https://${DOMAIN}/notices/pension-2026.pdf`);
  });

  it.each([
    ['outside_jurisdiction', { locationId: 'OTHER' }],
    ['category_not_allowed', { categoryId: 'CIVIC' }],
    ['source_not_official_domain', { originalSourceUrl: 'https://random-blog.example.com/pension' }],
    ['high_risk_content', { headline: 'Officer arrested over pension scam', summary: 'Police allege a scam in pension payments.' }],
  ])('routes to editorial review instead of publishing: %s', async (reason, overrides) => {
    const { admin, publisher, editor, announcement, civic } = await setup();
    const otherState = (await admin.post('/api/v1/admin/locations', { parentId: null, level: 'state', nameEn: 'Another State' }).expect(201)).body.location;
    const resolved = Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [k, v === 'OTHER' ? otherState.id : v === 'CIVIC' ? civic : v]),
    );
    const res = await publisher.post('/api/v1/publisher/announcements', announcement(resolved)).expect(202);
    expect(res.body).toMatchObject({ outcome: 'sent_for_review', reasons: [reason] });

    // The publisher can track it; editors see it in the queue as a publisher submission.
    const tracked = (await publisher.get(`/api/v1/submissions/${res.body.submissionId}`).expect(200)).body.submission;
    expect(tracked.timeline[0]).toMatchObject({ action: 'routed_to_review', actorRole: 'system' });
    const queue = (await editor.get('/api/v1/editorial/submissions').expect(200)).body.items;
    expect(queue[0]).toMatchObject({ id: res.body.submissionId, origin: 'publisher' });
  });

  it('an organisation that is not yet active cannot publish directly', async () => {
    const { publisher, announcement } = await setup('onboarding');
    const res = await publisher.post('/api/v1/publisher/announcements', announcement()).expect(202);
    expect(res.body.reasons).toEqual(['organisation_not_active']);
  });

  it('when an editor publishes a routed announcement it keeps the official label and source', async () => {
    const { publisher, editor, announcement } = await setup('onboarding');
    const { submissionId } = (await publisher.post('/api/v1/publisher/announcements', announcement()).expect(202)).body;
    await editor.post(`/api/v1/editorial/submissions/${submissionId}/claim`, {}).expect(200);
    const res = await editor.post(`/api/v1/editorial/submissions/${submissionId}/publish`, { trustLabel: 'editor_verified' }).expect(200);
    expect(res.body.submission.article).toMatchObject({ sourceType: 'official_publisher', trustLabel: 'official_unverified', deadline: '2026-11-15' });
  });

  it('requires the publisher role and a linked organisation', async () => {
    const { app, announcement } = await setup();
    const reporter = await userWithRoles(app, 'rep@example.in', ['reader', 'reporter']);
    await reporter.post('/api/v1/publisher/announcements', announcement()).expect(403);
    const unlinked = await userWithRoles(app, 'unlinked@example.in', ['reader', 'publisher']);
    await unlinked.post('/api/v1/publisher/announcements', announcement()).expect(403);
  });

  it('matches official domains exactly or as subdomains', () => {
    expect(isOfficialUrl('https://district.example.in/x', [DOMAIN])).toBe(true);
    expect(isOfficialUrl('https://www.district.example.in/x', [DOMAIN])).toBe(true);
    expect(isOfficialUrl('https://evil-district.example.in/x', [DOMAIN])).toBe(false);
    expect(isOfficialUrl('https://district.example.in.attacker.com/x', [DOMAIN])).toBe(false);
    expect(isOfficialUrl('javascript:alert(1)', [DOMAIN])).toBe(false);
  });
});

describe('reader reports', () => {
  it('readers report once per article; editors resolve; anonymous and unpublished are refused', async () => {
    const { app, admin, editor, publisher, announcement } = await setup();
    const article = (await publisher.post('/api/v1/publisher/announcements', announcement()).expect(201)).body.article;
    const reader = await userWithRoles(app, 'reader@example.in', ['reader']);

    await client(app).post(`/api/v1/articles/${article.id}/reports`, { reason: 'misleading' }).expect(401);
    await reader.post(`/api/v1/articles/${article.id}/reports`, { reason: 'misleading', details: 'The deadline was extended.' }).expect(201);
    await reader.post(`/api/v1/articles/${article.id}/reports`, { reason: 'spam' }).expect(409);
    await admin.post(`/api/v1/articles/${article.id}/reports`, { reason: 'false_information' }).expect(201);

    await reader.get('/api/v1/moderation/reports').expect(403);
    const open = (await editor.get('/api/v1/moderation/reports').expect(200)).body.items;
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ reason: 'misleading', reportCountForArticle: 2, article: { id: article.id } });
    expect(JSON.stringify(open)).not.toContain('reader@example.in');

    await editor.post(`/api/v1/moderation/reports/${open[0].id}/resolve`, { outcome: 'actioned', note: 'Correction issued.' }).expect(200);
    await editor.post(`/api/v1/moderation/reports/${open[0].id}/resolve`, { outcome: 'dismissed', note: 'again' }).expect(409);
    expect((await editor.get('/api/v1/moderation/reports').expect(200)).body.items).toHaveLength(1);

    await editor.post(`/api/v1/editorial/articles/${article.id}/unpublish`, { reason: 'Checking the notice' }).expect(200);
    const another = await userWithRoles(app, 'another@example.in', ['reader']);
    await another.post(`/api/v1/articles/${article.id}/reports`, { reason: 'spam' }).expect(404);
  });
});
