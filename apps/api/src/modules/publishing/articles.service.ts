import { Types, type FilterQuery } from 'mongoose';
import type {
  ArticleDetail,
  ArticleSummary,
  ChangeKind,
  CreateArticleRequest,
  ReviseArticleRequest,
} from '@locallens/contracts';
import { AppError, Errors } from '../../lib/errors';
import { CategoryModel, toCategory } from '../catalog/catalog';
import { getLocationOrThrow, toSummaries } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { photoUrl } from '../media/media';
import { articleChanged, articlePublished, istDate } from '../notifications/events';
import { ArticleModel, ArticleRevisionModel, type Article, type ArticleDoc } from './article.model';

const toDeadline = (d: string | null | undefined): Date | null | undefined => (d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`));

const DUPLICATE_KEY = 11000;
const PUBLIC_STATUSES = ['published', 'retracted'] as const;

// ---------- cursors ----------
interface Cursor {
  t: string;
  id: string;
}
const encodeCursor = (a: ArticleDoc) =>
  Buffer.from(JSON.stringify({ t: a.firstPublishedAt.toISOString(), id: a.id } satisfies Cursor)).toString('base64url');

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (typeof c.t !== 'string' || !Types.ObjectId.isValid(c.id) || Number.isNaN(Date.parse(c.t))) throw new Error();
    return c;
  } catch {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor');
  }
}

/** Keyset pagination: "older than the last item seen". Stable while new articles are published. */
function afterCursor(c: Cursor | null): FilterQuery<Article> {
  if (!c) return {};
  const t = new Date(c.t);
  return { $or: [{ firstPublishedAt: { $lt: t } }, { firstPublishedAt: t, _id: { $lt: new Types.ObjectId(c.id) } }] };
}

async function page(filter: FilterQuery<Article>, limit: number, cursor: string | undefined) {
  const docs = await ArticleModel.find({ $and: [filter, afterCursor(decodeCursor(cursor))] })
    .sort({ firstPublishedAt: -1, _id: -1 })
    .limit(limit + 1);
  const items = docs.slice(0, limit);
  return { items: await toArticleSummaries(items), nextCursor: docs.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

// ---------- shaping ----------
export async function toArticleSummaries(docs: ArticleDoc[]): Promise<ArticleSummary[]> {
  const [locations, categories] = await Promise.all([
    LocationModel.find({ _id: { $in: docs.map((d) => d.locationId) } }),
    CategoryModel.find({ _id: { $in: docs.map((d) => d.categoryId) } }),
  ]);
  const locSummaries = new Map((await toSummaries(locations)).map((l) => [l.id, l]));
  const cats = new Map(categories.map((c) => [c.id as string, toCategory(c)]));
  return docs.map((d) => ({
    id: d.id as string,
    slug: d.slug,
    status: d.status,
    headline: d.headline,
    summary: d.summary,
    language: d.language,
    location: locSummaries.get(String(d.locationId))!,
    category: cats.get(String(d.categoryId))!,
    trustLabel: d.trustLabel,
    sourceType: d.sourceType,
    firstPublishedAt: d.firstPublishedAt.toISOString(),
    lastUpdatedAt: d.lastUpdatedAt.toISOString(),
    correctionCount: d.correctionCount,
    deadline: d.deadline ? d.deadline.toISOString().slice(0, 10) : null,
    // A retracted article's photo is withdrawn with its text.
    imageUrl: d.status === 'retracted' ? null : (d.imageUrl ?? photoUrl(d.imageId)),
    externalSource: d.externalSource ? { name: d.externalSource.name, url: d.originalSourceUrl ?? d.externalSource.url } : null,
  }));
}

export async function toArticleDetail(doc: ArticleDoc): Promise<ArticleDetail> {
  const [summary] = await toArticleSummaries([doc]);
  const revisions = await ArticleRevisionModel.find({ articleId: doc._id }).sort({ revisionNumber: 1 });
  return {
    ...summary!,
    // A retracted article stays at its URL with the notice, but its text is withdrawn.
    body: doc.status === 'retracted' ? null : doc.body,
    originalSourceUrl: doc.originalSourceUrl,
    history: revisions.map((r) => ({
      revisionNumber: r.revisionNumber,
      changeKind: r.changeKind,
      publicNote: r.publicNote,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ---------- public reads ----------
/**
 * News for a place: everything tagged inside it (its mandals and villages), plus news tagged to the places above it
 * (district- or state-wide news matters to a village). Only published articles; retracted ones are reachable by URL
 * but not listed.
 */
export async function publicFeed(opts: { locationId?: string; categoryId?: string; limit: number; cursor?: string }) {
  const filter: FilterQuery<Article> = { status: 'published' };
  const and: FilterQuery<Article>[] = [];
  if (opts.locationId) {
    const loc = await getLocationOrThrow(opts.locationId);
    and.push({ $or: [{ locationLineage: loc._id }, { locationId: { $in: loc.ancestorIds } }] });
  }
  if (opts.categoryId) and.push({ categoryId: new Types.ObjectId(opts.categoryId) });
  return page(and.length ? { ...filter, $and: and } : filter, opts.limit, opts.cursor);
}

/** Personalised feed: anything matching a followed location (with the same inside/above rule) or category. */
export async function followedFeed(locationIds: Types.ObjectId[], categoryIds: Types.ObjectId[], limit: number, cursor?: string) {
  if (!locationIds.length && !categoryIds.length) return { items: [], nextCursor: null };
  const locations = await LocationModel.find({ _id: { $in: locationIds } });
  const ancestors = locations.flatMap((l) => l.ancestorIds);
  const or: FilterQuery<Article>[] = [];
  if (locations.length) or.push({ locationLineage: { $in: locations.map((l) => l._id) } }, { locationId: { $in: ancestors } });
  if (categoryIds.length) or.push({ categoryId: { $in: categoryIds } });
  return page({ status: 'published', $or: or }, limit, cursor);
}

/** Published articles whose deadline is today or later (India date), soonest first; same place rule as the feed. */
export async function upcomingDeadlines(opts: { locationId?: string; limit: number }): Promise<ArticleSummary[]> {
  const filter: FilterQuery<Article> = { status: 'published', deadline: { $gte: istDate() } };
  if (opts.locationId) {
    const loc = await getLocationOrThrow(opts.locationId);
    filter.$or = [{ locationLineage: loc._id }, { locationId: { $in: loc.ancestorIds } }];
  }
  return toArticleSummaries(await ArticleModel.find(filter).sort({ deadline: 1, _id: 1 }).limit(opts.limit));
}

export async function searchArticles(q: string, limit: number): Promise<ArticleSummary[]> {
  const docs = await ArticleModel.find({ status: 'published', $text: { $search: q } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' }, firstPublishedAt: -1 })
    .limit(limit);
  return toArticleSummaries(docs);
}

export async function getPublicArticle(slug: string): Promise<ArticleDoc> {
  const doc = await ArticleModel.findOne({ slug, status: { $in: PUBLIC_STATUSES } });
  if (!doc) throw Errors.notFound('Article not found');
  return doc;
}

// ---------- editorial writes ----------
/** URL-safe and stable: derived once from the headline (Telugu headlines fall back to "news") plus a unique suffix. */
export function makeSlug(headline: string, id: Types.ObjectId): string {
  const words = headline
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${words || 'news'}-${id.toHexString().slice(-8)}`;
}

export interface ArticleOrigin {
  submissionId?: Types.ObjectId;
  publisherOrgId?: Types.ObjectId;
  deadline?: Date | null;
  imageId?: Types.ObjectId | null;
  imageUrl?: string | null;
  imagePublicId?: string | null;
  /** Quick posts that must wait for an editor are created unpublished. */
  status?: 'published' | 'unpublished';
  holdReason?: Article['holdReason'];
}

export async function createArticle(input: CreateArticleRequest, editorId: Types.ObjectId, origin: ArticleOrigin = {}): Promise<ArticleDoc> {
  const [location, category] = await Promise.all([
    LocationModel.findById(input.locationId),
    CategoryModel.findById(input.categoryId),
  ]);
  if (!location) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown location', [{ path: 'locationId', message: 'Unknown location' }]);
  if (!category) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category', [{ path: 'categoryId', message: 'Unknown category' }]);

  const now = new Date();
  const articleId = new Types.ObjectId();
  const deadline = toDeadline(input.deadline) ?? origin.deadline ?? null;
  // Revision first, with the article id allocated up front: if the second write failed, readers would see nothing
  // rather than an article without history. (No multi-document transaction needed.)
  await ArticleRevisionModel.create({
    articleId,
    revisionNumber: 1,
    headline: input.headline,
    summary: input.summary,
    body: input.body,
    trustLabel: input.trustLabel,
    changeKind: 'initial',
    publicNote: null,
    deadline,
    editorId,
  });
  const article = await ArticleModel.create({
    _id: articleId,
    slug: makeSlug(input.headline, articleId),
    status: origin.status ?? 'published',
    revisionCount: 1,
    headline: input.headline,
    summary: input.summary,
    body: input.body,
    trustLabel: input.trustLabel,
    language: input.language,
    locationId: location._id,
    locationLineage: [location._id, ...location.ancestorIds],
    categoryId: category._id,
    sourceType: input.sourceType,
    originalSourceUrl: input.originalSourceUrl ?? null,
    firstPublishedAt: now,
    lastUpdatedAt: now,
    createdBy: editorId,
    submissionId: origin.submissionId ?? null,
    publisherOrgId: origin.publisherOrgId ?? null,
    deadline,
    imageId: origin.imageId ?? null,
    imageUrl: origin.imageUrl ?? null,
    imagePublicId: origin.imagePublicId ?? null,
    holdReason: origin.holdReason ?? null,
    searchText: `${input.headline} ${input.summary}`,
  });
  if (article.status === 'published') await articlePublished(article._id);
  return article;
}

export async function getArticleForEditor(id: string): Promise<ArticleDoc> {
  const doc = await ArticleModel.findById(id);
  if (!doc) throw Errors.notFound('Article not found');
  return doc;
}

/** Applies a change as a new immutable revision. Concurrent edits: the unique revision number lets one win (409 for the other). */
async function addRevision(
  article: ArticleDoc,
  change: {
    changeKind: ChangeKind;
    headline?: string;
    summary?: string;
    body?: string;
    trustLabel?: Article['trustLabel'];
    deadline?: Date | null;
    publicNote: string | null;
  },
  editorId: Types.ObjectId,
): Promise<ArticleDoc> {
  const next = {
    headline: change.headline ?? article.headline,
    summary: change.summary ?? article.summary,
    body: change.body ?? article.body,
    trustLabel: change.trustLabel ?? article.trustLabel,
    deadline: change.deadline === undefined ? article.deadline : change.deadline,
  };
  const revisionNumber = article.revisionCount + 1;
  try {
    await ArticleRevisionModel.create({ articleId: article._id, revisionNumber, ...next, changeKind: change.changeKind, publicNote: change.publicNote, editorId });
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY) throw Errors.conflict('Someone else changed this article. Reload and try again.');
    throw err;
  }
  const isCorrection = change.changeKind === 'correction' || change.changeKind === 'clarification';
  const updated = await ArticleModel.findOneAndUpdate(
    { _id: article._id, revisionCount: article.revisionCount },
    {
      $set: { ...next, revisionCount: revisionNumber, lastUpdatedAt: new Date(), searchText: `${next.headline} ${next.summary}` },
      ...(isCorrection ? { $inc: { correctionCount: 1 } } : {}),
    },
    { new: true },
  );
  if (!updated) throw Errors.conflict('Someone else changed this article. Reload and try again.');
  if (change.changeKind !== 'update' && change.changeKind !== 'initial') {
    await articleChanged(updated._id, revisionNumber, change.changeKind === 'retraction' ? 'retracted' : 'corrected');
  }
  return updated;
}

export async function reviseArticle(id: string, input: ReviseArticleRequest, editorId: Types.ObjectId): Promise<ArticleDoc> {
  const article = await getArticleForEditor(id);
  if (article.status === 'retracted') throw Errors.conflict('A retracted article cannot be changed');
  const deadline = toDeadline(input.deadline);
  const changesDate = deadline !== undefined && (deadline?.getTime() ?? null) !== (article.deadline?.getTime() ?? null);
  if (changesDate && article.deadline && input.changeKind === 'update') {
    throw new AppError(400, 'VALIDATION_FAILED', 'Changing a published deadline is a correction', [
      { path: 'changeKind', message: 'Changing a published deadline must be a correction with a public note' },
    ]);
  }
  const { deadline: _ignored, ...rest } = input;
  return addRevision(article, { ...rest, ...(deadline !== undefined ? { deadline } : {}), publicNote: input.publicNote ?? null }, editorId);
}

export async function retractArticle(id: string, publicNote: string, editorId: Types.ObjectId): Promise<ArticleDoc> {
  const article = await getArticleForEditor(id);
  if (article.status === 'retracted') throw Errors.conflict('Already retracted');
  const updated = await addRevision(article, { changeKind: 'retraction', publicNote }, editorId);
  updated.status = 'retracted';
  return updated.save();
}

export async function setPublished(id: string, published: boolean): Promise<ArticleDoc> {
  const article = await getArticleForEditor(id);
  if (article.status === 'retracted') throw Errors.conflict('A retracted article cannot be unpublished or republished');
  const target = published ? 'published' : 'unpublished';
  if (article.status === target) throw Errors.conflict(`Already ${target}`);
  article.status = target;
  return article.save();
}

export async function editorialList(opts: { status?: Article['status']; limit: number; cursor?: string }) {
  return page(opts.status ? { status: opts.status } : {}, opts.limit, opts.cursor);
}
