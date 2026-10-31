import { Router } from 'express';
import { Schema, model, type FilterQuery } from 'mongoose';
import type { Logger } from 'pino';
import { AiAnswerResult, AskRequest, type AskResponse } from '@locallens/contracts';
import type { Config } from '../../config';
import { sha256 } from '../../lib/crypto';
import { currentUser, requireAuth } from '../../middleware/auth';
import { rateLimit, type RateLimiters } from '../../middleware/rate-limit';
import { getLocationOrThrow, toSummaries } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { ArticleModel, ArticleRevisionModel, type Article, type ArticleDoc } from '../publishing/article.model';
import { AiClient } from '../verification/verification';

/**
 * The news assistant: answers a reader's question from published LocalLens articles only.
 *
 * Guardrails (tested):
 * - Retrieval happens here, from published articles; the model never searches or browses.
 * - No matching articles means "insufficient information" WITHOUT a model call (also saves cost).
 * - Citations are re-checked against the articles we sent; an answer with no valid citation is not shown.
 * - Any AI failure becomes status "unavailable" — the reader is never shown an unchecked answer.
 * - Questions are not stored or logged (only a hash, as the cache key).
 */

const MAX_ARTICLES = 6;
const CACHE_HOURS = 24;

interface CachedAnswer {
  key: string;
  response: Omit<AskResponse, 'cached'>;
  expiresAt: Date;
}
const cacheSchema = new Schema<CachedAnswer>({
  key: { type: String, required: true, unique: true },
  response: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});
cacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AssistantCacheModel = model<CachedAnswer>('AssistantCache', cacheSchema, 'assistant_cache');

/** Words that carry no search meaning; the text index uses no language analyser (there is none for Telugu). */
const STOPWORDS = new Set(
  'a an and are about any at be did do does for from has have how i in is it me of on or tell the there this to was were what when where which who why will with'.split(' '),
);
export function searchTerms(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .join(' ');
}

async function retrieve(input: ReturnType<typeof AskRequest.parse>): Promise<ArticleDoc[]> {
  const docs: ArticleDoc[] = [];
  if (input.articleSlug) {
    const current = await ArticleModel.findOne({ slug: input.articleSlug, status: { $in: ['published', 'retracted'] } });
    if (current) docs.push(current);
  }
  const terms = searchTerms(input.question);
  if (terms) {
    const filter: FilterQuery<Article> = { status: 'published', $text: { $search: terms } };
    if (docs[0]) filter._id = { $ne: docs[0]._id };
    if (input.locationId) {
      const loc = await getLocationOrThrow(input.locationId);
      filter.$or = [{ locationLineage: loc._id }, { locationId: { $in: loc.ancestorIds } }];
    }
    const found = await ArticleModel.find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, firstPublishedAt: -1 })
      .limit(MAX_ARTICLES - docs.length);
    docs.push(...found);
  }
  return docs;
}

async function toAiArticles(docs: ArticleDoc[]) {
  const [locations, notes] = await Promise.all([
    LocationModel.find({ _id: { $in: docs.map((d) => d.locationId) } }).then(toSummaries),
    ArticleRevisionModel.find({ articleId: { $in: docs.map((d) => d._id) }, changeKind: { $in: ['correction', 'clarification', 'retraction'] } })
      .sort({ revisionNumber: 1 })
      .lean(),
  ]);
  return docs.map((d) => {
    const loc = locations.find((l) => l.id === d.locationId.toHexString());
    return {
      id: d._id.toHexString(),
      headline: d.headline,
      summary: d.summary,
      body: d.status === 'retracted' ? null : d.body.slice(0, 25_000),
      published_at: d.firstPublishedAt.toISOString().slice(0, 10),
      location_label: loc?.label ?? '',
      trust_label: d.trustLabel,
      corrections: notes.filter((n) => n.articleId.equals(d._id) && n.publicNote).map((n) => n.publicNote as string).slice(-20),
    };
  });
}

/** Same question over the same article versions gives the same answer: reuse it instead of paying for another call. */
function cacheKey(input: ReturnType<typeof AskRequest.parse>, docs: ArticleDoc[]): string {
  const question = input.question.toLowerCase().replace(/\s+/g, ' ').trim();
  const versions = docs.map((d) => `${d._id.toHexString()}:${d.revisionCount}:${d.status}`).sort();
  return sha256(JSON.stringify([question, input.language, input.simple, versions]));
}

export function assistantRouter(deps: { config: Config; limiters: RateLimiters; logger: Logger }): Router {
  const { config, limiters, logger } = deps;
  const client = config.AI_SERVICE_URL && config.AI_SERVICE_TOKEN ? new AiClient(config.AI_SERVICE_URL, config.AI_SERVICE_TOKEN, config.AI_ASSISTANT_TIMEOUT_MS) : null;
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/ask',
    rateLimit(limiters.assistant, { failClosed: true, key: (req) => currentUser(req)._id.toHexString() }),
    async (req, res) => {
      const input = AskRequest.parse(req.body);
      const docs = await retrieve(input);
      const empty = (status: AskResponse['status']): AskResponse => ({ status, answer: '', citations: [], generatedBy: null, cached: false });

      if (!docs.length) return res.json(empty('insufficient_information'));
      if (!client) return res.json(empty('unavailable'));

      const key = cacheKey(input, docs);
      const hit = await AssistantCacheModel.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
      if (hit) return res.json({ ...hit.response, cached: true } satisfies AskResponse);

      let result: AiAnswerResult;
      try {
        const raw = await client.post('/v1/answer', {
          question: input.question,
          answer_language: input.language,
          simple: input.simple,
          articles: await toAiArticles(docs),
        });
        result = AiAnswerResult.parse(raw);
      } catch (err) {
        logger.warn({ err: (err as Error).message, articles: docs.length }, 'assistant answer unavailable');
        return res.json(empty('unavailable'));
      }

      const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
      const cited = result.cited_article_ids.flatMap((id) => {
        const d = byId.get(id);
        return d ? [{ id, slug: d.slug, headline: d.headline }] : [];
      });
      const response: Omit<AskResponse, 'cached'> =
        result.status === 'answered' && cited.length && result.answer.trim()
          ? { status: 'answered', answer: result.answer.trim(), citations: cited, generatedBy: `${result.meta.provider}:${result.meta.model}` }
          : { ...empty('insufficient_information'), generatedBy: `${result.meta.provider}:${result.meta.model}` };
      await AssistantCacheModel.updateOne(
        { key },
        { $set: { response, expiresAt: new Date(Date.now() + CACHE_HOURS * 3600_000) } },
        { upsert: true },
      );
      res.json({ ...response, cached: false } satisfies AskResponse);
    },
  );

  return r;
}
