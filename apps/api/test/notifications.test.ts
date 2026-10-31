import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { JobModel, runDueJobs, runSweepers } from '../src/modules/jobs/jobs';
import { istDate } from '../src/modules/notifications/events';
import { NotificationModel } from '../src/modules/notifications/notifications';
import { articleBody, categoryId, createTree } from './fixtures';
import { buildApp, userWithRoles, useTestDb } from './helpers';

useTestDb();

const logger = pino({ level: 'silent' });
const day = (offset: number) => istDate(offset).toISOString().slice(0, 10);
/** Run queued jobs now (the worker would pick them up within seconds). */
const work = async () => {
  await JobModel.updateMany({ status: 'pending' }, { $set: { runAfter: new Date(0) } });
  return runDueJobs(logger);
};

async function setup() {
  const { app } = buildApp();
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const villager = await userWithRoles(app, 'villager@example.in', ['reader']);
  const neighbour = await userWithRoles(app, 'neighbour@example.in', ['reader']);
  const topicFan = await userWithRoles(app, 'topic@example.in', ['reader']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const education = await categoryId(editor, 'education');
  await villager.put(`/api/v1/me/follows/location/${tree.village.id}`, {}).expect(204);
  await neighbour.put(`/api/v1/me/follows/location/${tree.mandalB.id}`, {}).expect(204);
  await topicFan.put(`/api/v1/me/follows/category/${education}`, {}).expect(204);
  const publish = async (locationId: string, overrides: Record<string, unknown> = {}, catId = civic) =>
    (await editor.post('/api/v1/editorial/articles', articleBody(locationId, catId, overrides)).expect(201)).body.article;
  const inbox = async (c: typeof villager) => (await c.get('/api/v1/me/notifications').expect(200)).body;
  return { app, editor, villager, neighbour, topicFan, tree, civic, education, publish, inbox };
}

describe('notifications', () => {
  it('tells followers of a place about news inside it and news for the area above it; not other places', async () => {
    const { editor, villager, neighbour, topicFan, tree, education, publish, inbox } = await setup();
    const villageNews = await publish(tree.village.id);
    const districtNews = await publish(tree.district.id, { headline: 'District-wide water schedule' });
    const otherMandal = await publish(tree.mandalB.id, { headline: 'Beta Mandal road works' });
    const schoolNews = await publish(tree.mandalB.id, { headline: 'School exam dates announced' }, education);
    await work();

    const mine = await inbox(villager);
    expect(mine.items.map((n: { article: { id: string } }) => n.article.id).sort()).toEqual([villageNews.id, districtNews.id].sort());
    expect(mine.items[0]).toMatchObject({ kind: 'new_article', readAt: null });
    expect(mine.unreadCount).toBe(2);
    expect((await inbox(neighbour)).items.map((n: { article: { id: string } }) => n.article.id).sort()).toEqual([districtNews.id, otherMandal.id, schoolNews.id].sort());
    expect((await inbox(topicFan)).items.map((n: { article: { id: string } }) => n.article.id)).toEqual([schoolNews.id]);
    expect((await inbox(editor)).items).toEqual([]); // the author is not notified about their own article

    // Re-running (a retry, or the repair sweeper) never notifies twice.
    await runSweepers(logger);
    await work();
    expect((await inbox(villager)).items).toHaveLength(2);
  });

  it('a correction reaches people who saved the article or were told about it; a routine update does not', async () => {
    const { app, editor, villager, tree, publish, inbox } = await setup();
    const saver = await userWithRoles(app, 'saver@example.in', ['reader']);
    const article = await publish(tree.village.id);
    await work();
    await saver.put(`/api/v1/me/saved/${article.id}`, {}).expect(204);

    await editor.post(`/api/v1/editorial/articles/${article.id}/revisions`, { changeKind: 'update', summary: 'Repairs will also cover the bus stand road.' }).expect(200);
    await work();
    expect((await inbox(saver)).items).toEqual([]);

    await editor
      .post(`/api/v1/editorial/articles/${article.id}/revisions`, { changeKind: 'correction', summary: 'Repairs take three weeks.', publicNote: 'The repair period is three weeks, not two.' })
      .expect(200);
    await work();
    expect((await inbox(saver)).items.map((n: { kind: string }) => n.kind)).toEqual(['article_corrected']);
    expect((await inbox(villager)).items.map((n: { kind: string }) => n.kind)).toEqual(['article_corrected', 'new_article']);
  });

  it('a retraction is announced, and notifications about unpublished articles are hidden', async () => {
    const { app, editor, villager, tree, publish, inbox } = await setup();
    const senior = await userWithRoles(app, 'senior@example.in', ['reader', 'senior_editor']);
    const wrong = await publish(tree.village.id, { headline: 'A report that turned out wrong' });
    const pulled = await publish(tree.village.id, { headline: 'An article pulled for legal review' });
    await work();
    await senior.post(`/api/v1/editorial/articles/${wrong.id}/retract`, { publicNote: 'The report could not be confirmed.' }).expect(200);
    await editor.post(`/api/v1/editorial/articles/${pulled.id}/unpublish`, { reason: 'Legal review requested' }).expect(200);
    await work();
    const items = (await inbox(villager)).items as { kind: string; article: { id: string } }[];
    expect(items.map((n) => `${n.kind}:${n.article.id}`).sort()).toEqual([`article_retracted:${wrong.id}`, `new_article:${wrong.id}`].sort());
  });

  it('reminds once when a deadline is 3 days away, and lists upcoming deadlines soonest first', async () => {
    const { app, editor, villager, tree, publish, inbox } = await setup();
    const soon = await publish(tree.district.id, { headline: 'Pension applications close soon', deadline: day(2) });
    const later = await publish(tree.village.id, { headline: 'Scholarship forms due next month', deadline: day(25) });
    await publish(tree.village.id, { headline: 'Old notice whose deadline passed', deadline: day(-1) });
    await publish(tree.mandalB.id, { headline: 'Beta Mandal ration card camp', deadline: day(1) });
    await work();
    await NotificationModel.updateMany({}, { $set: { readAt: new Date() } }); // clear the new-article alerts

    await runSweepers(logger);
    await runSweepers(logger); // the daily job is queued once per India date
    expect(await JobModel.countDocuments({ type: 'notify_deadlines' })).toBe(1);
    await work();
    const reminders = (await inbox(villager)).items.filter((n: { kind: string }) => n.kind === 'deadline_soon');
    expect(reminders).toEqual([expect.objectContaining({ article: expect.objectContaining({ id: soon.id, deadline: day(2) }) })]);

    const anon = (await import('./helpers')).client(app);
    const list = (await anon.get(`/api/v1/articles/deadlines?locationId=${tree.village.id}`).expect(200)).body.items;
    expect(list.map((a: { id: string }) => a.id)).toEqual([soon.id, later.id]); // past and other-mandal deadlines excluded
    expect(list[0].deadline).toBe(day(2));
    void editor;
  });

  it('changing a published deadline must be a correction, and it re-arms the reminder for the new date', async () => {
    const { app, editor, tree, publish } = await setup();
    const saver = await userWithRoles(app, 'saver@example.in', ['reader']);
    const a = await publish(tree.village.id, { deadline: day(2) });
    await saver.put(`/api/v1/me/saved/${a.id}`, {}).expect(204);
    const asUpdate = await editor.post(`/api/v1/editorial/articles/${a.id}/revisions`, { changeKind: 'update', deadline: day(3) }).expect(400);
    expect(asUpdate.body.error.details[0].path).toBe('changeKind');

    await runSweepers(logger);
    await work();
    await editor.post(`/api/v1/editorial/articles/${a.id}/revisions`, { changeKind: 'correction', deadline: day(1), publicNote: 'The last date is one day earlier.' }).expect(200);
    await JobModel.deleteMany({ type: 'notify_deadlines' }); // simulate the next day's run
    await runSweepers(logger);
    await work();
    const kinds = await NotificationModel.find({ articleId: a.id, userId: (await saverId(saver)) }).sort({ _id: 1 }).lean();
    expect(kinds.map((n) => n.kind)).toEqual(['deadline_soon', 'article_corrected', 'deadline_soon']);
    expect(kinds.map((n) => n.revision)).toContain(Number(day(1).replaceAll('-', '')));
  });

  it('marks notifications read (some or all), only for their owner', async () => {
    const { villager, neighbour, tree, publish, inbox } = await setup();
    await publish(tree.village.id);
    await publish(tree.district.id, { headline: 'District-wide water schedule' });
    await work();
    const [first] = (await inbox(villager)).items;
    // Someone else cannot mark my notification read
    await neighbour.post('/api/v1/me/notifications/read', { ids: [first.id] }).expect(200);
    expect((await villager.get('/api/v1/me/notifications/unread-count').expect(200)).body.unreadCount).toBe(2);

    expect((await villager.post('/api/v1/me/notifications/read', { ids: [first.id] }).expect(200)).body.unreadCount).toBe(1);
    expect((await villager.post('/api/v1/me/notifications/read', {}).expect(200)).body.unreadCount).toBe(0);
    await villager.post('/api/v1/me/notifications/read', { ids: ['nope'] }).expect(400);
  });

  it('pages through notifications newest first', async () => {
    const { villager, tree, publish } = await setup();
    for (let i = 0; i < 3; i++) await publish(tree.village.id, { headline: `Village notice number ${i}` });
    await work();
    const p1 = (await villager.get('/api/v1/me/notifications?limit=2').expect(200)).body;
    expect(p1.items.map((n: { article: { headline: string } }) => n.article.headline)).toEqual(['Village notice number 2', 'Village notice number 1']);
    const p2 = (await villager.get(`/api/v1/me/notifications?limit=2&cursor=${p1.nextCursor}`).expect(200)).body;
    expect(p2).toMatchObject({ nextCursor: null, items: [expect.objectContaining({ article: expect.objectContaining({ headline: 'Village notice number 0' }) })] });
  });
});

async function saverId(c: { get: (p: string) => { expect: (s: number) => Promise<{ body: { user: { id: string } } }> } }) {
  return (await c.get('/api/v1/auth/me').expect(200)).body.user.id;
}
