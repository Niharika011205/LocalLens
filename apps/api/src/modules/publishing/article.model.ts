import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  ARTICLE_STATUSES,
  CHANGE_KINDS,
  LANGUAGES,
  SOURCE_TYPES,
  TRUST_LABELS,
  type ArticleStatus,
  type ChangeKind,
  type Language,
  type SourceType,
  type TrustLabel,
  POST_HOLD_REASONS,
  type PostHoldReason,
} from '@locallens/contracts';

/** The public object. Only `published` (and `retracted`, with its notice) is ever served to readers. */
export interface Article {
  slug: string;
  status: ArticleStatus;
  revisionCount: number;
  // Denormalised copy of the current revision, for fast reads.
  headline: string;
  summary: string;
  body: string;
  trustLabel: TrustLabel;
  language: Language;
  locationId: Types.ObjectId;
  /** [locationId, ...its ancestors]: lets "news inside Guntur" be one multikey index lookup. */
  locationLineage: Types.ObjectId[];
  categoryId: Types.ObjectId;
  sourceType: SourceType;
  originalSourceUrl: string | null;
  firstPublishedAt: Date;
  lastUpdatedAt: Date;
  correctionCount: number;
  createdBy: Types.ObjectId;
  /** The citizen submission this article came from (never exposed publicly). */
  submissionId: Types.ObjectId | null;
  publisherOrgId: Types.ObjectId | null;
  /** For announcements with a deadline (applications, fees, exams). */
  deadline: Date | null;
  /** Photo in GridFS (media module), already cleaned of metadata. */
  imageId: Types.ObjectId | null;
  /** Photo URL when it lives elsewhere: Cloudinary (our upload) or the news site (imported stories). */
  imageUrl: string | null;
  /** Cloudinary id, so the photo can be deleted there. */
  imagePublicId: string | null;
  /** Imported stories: the site it came from and a stable id (hash of the link) for de-duplication. */
  externalSource: { name: string; url: string; feedId: string; photoChecked?: boolean } | null;
  externalId: string | null;
  /** Quick posts only: why it is not live (held for an editor, removed by reports, by its author, by an editor). */
  holdReason: PostHoldReason | null;
  /** Headline + summary, for the text index. */
  searchText: string;
}
export type ArticleDoc = HydratedDocument<Article>;

const articleSchema = new Schema<Article>(
  {
    slug: { type: String, required: true, unique: true },
    status: { type: String, enum: ARTICLE_STATUSES, required: true },
    revisionCount: { type: Number, required: true },
    headline: { type: String, required: true },
    summary: { type: String, required: true },
    body: { type: String, required: true },
    trustLabel: { type: String, enum: TRUST_LABELS, required: true },
    language: { type: String, enum: LANGUAGES, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    locationLineage: { type: [Schema.Types.ObjectId], required: true },
    categoryId: { type: Schema.Types.ObjectId, required: true },
    sourceType: { type: String, enum: SOURCE_TYPES, required: true },
    originalSourceUrl: { type: String, default: null },
    firstPublishedAt: { type: Date, required: true },
    lastUpdatedAt: { type: Date, required: true },
    correctionCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    submissionId: { type: Schema.Types.ObjectId, default: null },
    publisherOrgId: { type: Schema.Types.ObjectId, default: null },
    deadline: { type: Date, default: null },
    imageId: { type: Schema.Types.ObjectId, default: null },
    imageUrl: { type: String, default: null },
    imagePublicId: { type: String, default: null },
    externalSource: { type: { name: String, url: String, feedId: String, photoChecked: Boolean }, default: null, _id: false },
    externalId: { type: String, default: null },
    holdReason: { type: String, enum: [...POST_HOLD_REASONS, null], default: null },
    searchText: { type: String, required: true },
  },
  { timestamps: true },
);
articleSchema.index({ createdBy: 1, trustLabel: 1, firstPublishedAt: -1 }); // "My posts"
articleSchema.index({ trustLabel: 1, status: 1, holdReason: 1, updatedAt: -1 }); // editors' held-posts queue
articleSchema.index({ imageId: 1 }, { partialFilterExpression: { imageId: { $type: 'objectId' } } });
articleSchema.index({ externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });
articleSchema.index({ sourceType: 1, firstPublishedAt: 1 }); // pruning old imported stories
articleSchema.index({ status: 1, deadline: 1 }, { partialFilterExpression: { deadline: { $type: 'date' } } });
// Feed indexes: every public query filters on status and sorts newest first with _id as the tie-breaker.
articleSchema.index({ status: 1, firstPublishedAt: -1, _id: -1 });
articleSchema.index({ status: 1, locationLineage: 1, firstPublishedAt: -1, _id: -1 });
articleSchema.index({ status: 1, locationId: 1, firstPublishedAt: -1, _id: -1 });
articleSchema.index({ status: 1, categoryId: 1, firstPublishedAt: -1, _id: -1 });
// "none": no stemming or stop words — MongoDB has no Telugu analyzer, and English stemming would mangle Telugu.
articleSchema.index({ searchText: 'text' }, { default_language: 'none', language_override: '_noLanguageOverride' });

export const ArticleModel = model<Article>('Article', articleSchema, 'articles');

/** Immutable: one document per version of an article. Never updated or deleted. */
export interface ArticleRevision {
  articleId: Types.ObjectId;
  revisionNumber: number;
  headline: string;
  summary: string;
  body: string;
  trustLabel: TrustLabel;
  changeKind: ChangeKind;
  publicNote: string | null;
  deadline: Date | null;
  editorId: Types.ObjectId;
  createdAt: Date;
}

const revisionSchema = new Schema<ArticleRevision>(
  {
    articleId: { type: Schema.Types.ObjectId, required: true },
    revisionNumber: { type: Number, required: true },
    headline: { type: String, required: true },
    summary: { type: String, required: true },
    body: { type: String, required: true },
    trustLabel: { type: String, enum: TRUST_LABELS, required: true },
    changeKind: { type: String, enum: CHANGE_KINDS, required: true },
    publicNote: { type: String, default: null },
    deadline: { type: Date, default: null },
    editorId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Unique per article: two editors saving at the same moment cannot both create revision N.
revisionSchema.index({ articleId: 1, revisionNumber: 1 }, { unique: true });

export const ArticleRevisionModel = model<ArticleRevision>('ArticleRevision', revisionSchema, 'article_revisions');
