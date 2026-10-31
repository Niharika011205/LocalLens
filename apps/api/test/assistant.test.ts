import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRateLimiters, DEFAULT_LIMITS } from '../src/middleware/rate-limit';
import { searchTerms } from '../src/modules/assistant/assistant';
import { articleBody, categoryId, createTree } from './fixtures';
import { buildApp, client, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

const TOKEN = 'x'.repeat(40);

// A fake AI service whose replies each test scripts.
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let received: Record<string, unknown>[] = [];
let server: Server;
let aiUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw || '{}'));
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
});

const META = { pipeline_version: 'assist-1.0.0', provider: 'scripted', model: 'm', prompt_versions: { answer: 'answer-v1' }, duration_ms: 3, warnings: [] };
const answered = (ids: string[], answer = 'Repairs start on Monday and traffic is diverted through the market road.') => ({
  status: 200,
  body: { status: 'answered', answer, cited_article_ids: ids, meta: META },
});

async function setup(opts: { aiOn?: boolean; assistantPoints?: number } = {}) {
  const config = testConfig(opts.aiOn === false ? {} : { AI_SERVICE_URL: aiUrl, AI_SERVICE_TOKEN: TOKEN });
  const limiters = createRateLimiters({ kind: 'memory' }, { ...DEFAULT_LIMITS, assistant: { points: opts.assistantPoints ?? 20, duration: 3600 } });
  const { app } = buildApp({ config, limiters });
  const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
  const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
  const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
  const tree = await createTree(admin);
  const civic = await categoryId(editor, 'civic_issues');
  const publish = async (locationId: string, overrides: Record<string, unknown> = {}) =>
    (await editor.post('/api/v1/editorial/articles', articleBody(locationId, civic, overrides)).expect(201)).body.article;
  return { app, editor, reader, tree, publish };
}

describe('news assistant', () => {
  it('answers from retrieved published articles, with checked citations', async () => {
    const { reader, tree, publish } = await setup();
    const road = await publish(tree.village.id);
    await publish(tree.village.id, { headline: 'Library timings change', summary: 'The library opens at nine now.', body: 'From Monday the library opens at nine in the morning.' });

    replies.push(answered([road.id, 'not-an-article-we-sent']));
    const res = await reader.post('/api/v1/assistant/ask', { question: 'When do the road repairs start?', language: 'en' }).expect(200);
    expect(res.body).toMatchObject({ status: 'answered', cached: false, generatedBy: 'scripted:m' });
    expect(res.body.citations).toEqual([{ id: road.id, slug: road.slug, headline: road.headline }]); // the unknown id is dropped

    const sent = received[0] as { question: string; answer_language: string; articles: { id: string; trust_label: string }[] };
    expect(sent.answer_language).toBe('en');
    expect(sent.articles.map((a) => a.id)).toContain(road.id);
    expect(sent.articles[0]).toMatchObject({ trust_label: 'editor_verified', location_label: expect.stringContaining('Alpha Village') });
  });

  it('says it does not know, without calling the model, when nothing published matches', async () => {
    const { reader, tree, publish } = await setup();
    await publish(tree.village.id);
    const res = await reader.post('/api/v1/assistant/ask', { question: 'Who won the cricket match?' }).expect(200);
    expect(res.body).toMatchObject({ status: 'insufficient_information', answer: '', citations: [] });
    expect(received).toHaveLength(0);
  });

  it('never shows an answer without a valid citation', async () => {
    const { reader, tree, publish } = await setup();
    await publish(tree.village.id);
    replies.push(answered(['made-up-id']));
    const res = await reader.post('/api/v1/assistant/ask', { question: 'road repairs?' }).expect(200);
    expect(res.body).toMatchObject({ status: 'insufficient_information', answer: '' });
  });

  it('reports "unavailable" when the AI service fails or is not configured', async () => {
    const { reader, tree, publish } = await setup();
    await publish(tree.village.id);
    replies.push({ status: 503, body: { error: { message: 'model down' } } });
    expect((await reader.post('/api/v1/assistant/ask', { question: 'road repairs?' }).expect(200)).body.status).toBe('unavailable');
    replies.push({ status: 200, body: { status: 'answered', answer: 'x' } }); // malformed: no citations or meta
    expect((await reader.post('/api/v1/assistant/ask', { question: 'road repairs?' }).expect(200)).body.status).toBe('unavailable');

    // An app without AI configured, on the same database (the article is still published there)
    const { app: offApp } = buildApp({ config: testConfig() });
    const offReader = await userWithRoles(offApp, 'reader2@example.in', ['reader']);
    expect((await offReader.post('/api/v1/assistant/ask', { question: 'road repairs?' }).expect(200)).body.status).toBe('unavailable');
  });

  it('uses the article being read, includes public corrections, and only searches inside the chosen place', async () => {
    const { editor, reader, tree, publish } = await setup();
    const road = await publish(tree.village.id);
    await editor
      .post(`/api/v1/editorial/articles/${road.id}/revisions`, {
        changeKind: 'correction',
        summary: 'The main road will be repaired over the next three weeks.',
        publicNote: 'The repair period is three weeks, not two.',
      })
      .expect(200);
    const elsewhere = await publish(tree.mandalB.id, { headline: 'Road repairs in Beta Mandal' });

    replies.push(answered([road.id]));
    await reader.post('/api/v1/assistant/ask', { question: 'How long will it take?', articleSlug: road.slug, locationId: tree.mandalA.id }).expect(200);
    const sent = received[0] as { articles: { id: string; corrections: string[] }[] };
    expect(sent.articles[0]).toMatchObject({ id: road.id, corrections: ['The repair period is three weeks, not two.'] });
    expect(sent.articles.map((a) => a.id)).not.toContain(elsewhere.id);
  });

  it('caches identical questions over unchanged articles, and re-asks after an article changes', async () => {
    const { editor, reader, tree, publish } = await setup();
    const road = await publish(tree.village.id);
    replies.push(answered([road.id]));
    await reader.post('/api/v1/assistant/ask', { question: 'Road repairs?' }).expect(200);
    const again = await reader.post('/api/v1/assistant/ask', { question: '  road   REPAIRS? ' }).expect(200);
    expect(again.body).toMatchObject({ status: 'answered', cached: true });
    expect(received).toHaveLength(1);

    await editor
      .post(`/api/v1/editorial/articles/${road.id}/revisions`, { changeKind: 'update', summary: 'Repairs now include the bus stand road as well.' })
      .expect(200);
    replies.push(answered([road.id]));
    expect((await reader.post('/api/v1/assistant/ask', { question: 'Road repairs?' }).expect(200)).body.cached).toBe(false);
    expect(received).toHaveLength(2);
  });

  it('requires sign-in, validates input and limits questions per user', async () => {
    const { app, reader } = await setup({ assistantPoints: 3 }); // invalid requests count too (they still cost us work)
    await client(app).post('/api/v1/assistant/ask', { question: 'Road repairs?' }).expect(401);
    await reader.post('/api/v1/assistant/ask', { question: 'x' }).expect(400);
    await reader.post('/api/v1/assistant/ask', { question: 'Road repairs?', extra: true }).expect(400);
    await reader.post('/api/v1/assistant/ask', { question: 'Road repairs?' }).expect(200);
    const limited = await reader.post('/api/v1/assistant/ask', { question: 'Road repairs?' }).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('builds search terms without English filler words and keeps Telugu words', () => {
    expect(searchTerms('When do the road repairs start?')).toBe('road repairs start');
    expect(searchTerms('గుంటూరులో రోడ్డు మరమ్మతులు ఎప్పుడు?')).toBe('గుంటూరులో రోడ్డు మరమ్మతులు ఎప్పుడు');
  });
});
