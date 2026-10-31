import { z } from 'zod';
import { Language, ObjectIdString } from './common';
import { LocalizedName, LocationSummary } from './geo';

// ---------- categories ----------
export const CATEGORY_SLUGS = [
  'local_events',
  'education',
  'employment',
  'agriculture',
  'civic_issues',
  'government_announcements',
  'public_safety',
  'community_news',
] as const;
export const CategorySlug = z.enum(CATEGORY_SLUGS);
export type CategorySlug = z.infer<typeof CategorySlug>;

export const Category = z.object({ id: z.string(), slug: CategorySlug, name: LocalizedName });
export type Category = z.infer<typeof Category>;

export const CategoryListResponse = z.object({ items: z.array(Category) });
export type CategoryListResponse = z.infer<typeof CategoryListResponse>;

// ---------- articles ----------
export const ARTICLE_STATUSES = ['published', 'unpublished', 'retracted'] as const;
export const ArticleStatus = z.enum(ARTICLE_STATUSES);
export type ArticleStatus = z.infer<typeof ArticleStatus>;

/**
 * Shown to readers on every article. Editors choose the first four; nothing is labelled "verified" automatically.
 * "reporter_post" is set by the system on quick posts that went live without an editor.
 * "external_source" marks headlines imported from other news sites' public feeds (linked to the original).
 */
export const TRUST_LABELS = ['editor_verified', 'citizen_reviewed', 'official_unverified', 'developing', 'reporter_post', 'external_source'] as const;
/** The labels an editor may pick. */
export const EDITOR_TRUST_LABELS = ['editor_verified', 'citizen_reviewed', 'official_unverified', 'developing'] as const;
export const TrustLabel = z.enum(TRUST_LABELS);
export type TrustLabel = z.infer<typeof TrustLabel>;

export const SOURCE_TYPES = ['staff', 'citizen', 'official_publisher', 'external'] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

export const CHANGE_KINDS = ['initial', 'update', 'correction', 'clarification', 'retraction'] as const;
export const ChangeKind = z.enum(CHANGE_KINDS);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const RevisionEntry = z.object({
  revisionNumber: z.number(),
  changeKind: ChangeKind,
  publicNote: z.string().nullable(),
  createdAt: z.string(),
});
export type RevisionEntry = z.infer<typeof RevisionEntry>;

export const ArticleSummary = z.object({
  id: z.string(),
  slug: z.string(),
  status: ArticleStatus,
  headline: z.string(),
  summary: z.string(),
  language: Language,
  location: LocationSummary,
  category: Category,
  trustLabel: TrustLabel,
  sourceType: SourceType,
  firstPublishedAt: z.string(),
  lastUpdatedAt: z.string(),
  correctionCount: z.number(),
  /** YYYY-MM-DD, for announcements with a deadline. */
  deadline: z.string().nullable(),
  /** The photo: our own (Cloudinary or same-origin), or the news site's own image for imported stories. */
  imageUrl: z.string().nullable(),
  /** Imported stories only: which site it is from, and the link to the full story there. */
  externalSource: z.object({ name: z.string(), url: z.string() }).nullable(),
});
export type ArticleSummary = z.infer<typeof ArticleSummary>;

export const ArticleDetail = ArticleSummary.extend({
  /** null when the article has been retracted. */
  body: z.string().nullable(),
  originalSourceUrl: z.string().nullable(),
  /** Public history: every revision with its kind and note. */
  history: z.array(RevisionEntry),
});
export type ArticleDetail = z.infer<typeof ArticleDetail>;

export const ArticleResponse = z.object({ article: ArticleDetail });
export type ArticleResponse = z.infer<typeof ArticleResponse>;

export const ArticleListResponse = z.object({ items: z.array(ArticleSummary), nextCursor: z.string().nullable() });
export type ArticleListResponse = z.infer<typeof ArticleListResponse>;

export const FeedQuery = z.object({
  locationId: ObjectIdString.optional(),
  categoryId: ObjectIdString.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export const SearchArticlesQuery = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const EditorialListQuery = z.object({
  status: ArticleStatus.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const Headline = z.string().trim().min(5, 'Headline is too short').max(200);
const Summary = z.string().trim().min(10, 'Summary is too short').max(400);
const Body = z.string().trim().min(20, 'Body is too short').max(20_000);
const PublicNote = z.string().trim().min(5, 'Explain the change for readers').max(500);
/** A calendar date (YYYY-MM-DD, India time), e.g. the last day to apply. */
export const DeadlineDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const SourceUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link');

export const CreateArticleRequest = z
  .object({
    headline: Headline,
    summary: Summary,
    body: Body,
    language: Language,
    locationId: ObjectIdString,
    categoryId: ObjectIdString,
    trustLabel: TrustLabel,
    sourceType: SourceType,
    originalSourceUrl: SourceUrl.optional(),
    deadline: DeadlineDate.optional(),
  })
  .strict()
  .refine((a) => a.sourceType !== 'official_publisher' || !!a.originalSourceUrl, {
    path: ['originalSourceUrl'],
    message: 'Official announcements must link to the original source',
  });
export type CreateArticleRequest = z.infer<typeof CreateArticleRequest>;

export const ReviseArticleRequest = z
  .object({
    changeKind: z.enum(['update', 'correction', 'clarification']),
    headline: Headline.optional(),
    summary: Summary.optional(),
    body: Body.optional(),
    trustLabel: TrustLabel.optional(),
    /** null removes the deadline. A changed date is a correction readers must be told about. */
    deadline: DeadlineDate.nullable().optional(),
    publicNote: PublicNote.optional(),
  })
  .strict()
  .refine((r) => r.changeKind === 'update' || !!r.publicNote, {
    path: ['publicNote'],
    message: 'Corrections and clarifications need a public note',
  })
  .refine((r) => r.headline || r.summary || r.body || r.trustLabel || r.deadline !== undefined, { message: 'Nothing changed' });
export type ReviseArticleRequest = z.infer<typeof ReviseArticleRequest>;

export const RetractArticleRequest = z.object({ publicNote: PublicNote }).strict();
export const UnpublishArticleRequest = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const DeadlinesQuery = z.object({
  locationId: ObjectIdString.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const DeadlinesResponse = z.object({ items: z.array(ArticleSummary) });
export type DeadlinesResponse = z.infer<typeof DeadlinesResponse>;

// ---------- engagement ----------
export const FOLLOW_TARGETS = ['location', 'category'] as const;
export const FollowTarget = z.enum(FOLLOW_TARGETS);
export type FollowTarget = z.infer<typeof FollowTarget>;

export const FollowsResponse = z.object({
  locations: z.array(LocationSummary),
  categories: z.array(Category),
});
export type FollowsResponse = z.infer<typeof FollowsResponse>;

export const SavedListResponse = z.object({ items: z.array(ArticleSummary) });
export type SavedListResponse = z.infer<typeof SavedListResponse>;

export const SavedStatusResponse = z.object({ saved: z.boolean() });
export type SavedStatusResponse = z.infer<typeof SavedStatusResponse>;
