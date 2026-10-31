import { z } from 'zod';
import { Language, ObjectIdString } from './common';
import { ArticleSummary, Category, DeadlineDate, TrustLabel } from './articles';
import { LocationSummary } from './geo';
import { TrackRecord } from './track-record';

// ---------- submissions ----------
export const SUBMISSION_STATUSES = [
  'draft',
  'submitted',
  'in_review',
  'needs_info',
  'returned',
  'rejected',
  'published',
  'withdrawn',
] as const;
export const SubmissionStatus = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

/** AI analysis is a separate field: no editorial transition ever depends on it. */
export const AI_STATUSES = ['not_requested', 'pending', 'completed', 'failed', 'unavailable'] as const;
export const AiStatus = z.enum(AI_STATUSES);
export type AiStatus = z.infer<typeof AiStatus>;

export const RISK_LEVELS = ['normal', 'high'] as const;
export const RiskLevel = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const REJECTION_REASONS = [
  'insufficient_evidence',
  'duplicate',
  'not_local',
  'not_news',
  'inaccurate',
  'harmful_or_abusive',
  'other',
] as const;
export const RejectionReason = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof RejectionReason>;

export const SubmissionEvent = z.object({
  action: z.string(),
  fromStatus: SubmissionStatus.nullable(),
  toStatus: SubmissionStatus.nullable(),
  reasonCode: z.string().nullable(),
  note: z.string().nullable(),
  /** "reporter" or "editor" — editors' names are not shown to reporters. */
  actorRole: z.enum(['reporter', 'editor', 'system']),
  at: z.string(),
});
export type SubmissionEvent = z.infer<typeof SubmissionEvent>;

export const Submission = z.object({
  id: z.string(),
  status: SubmissionStatus,
  version: z.number(),
  headline: z.string(),
  summary: z.string(),
  body: z.string(),
  language: Language,
  location: LocationSummary.nullable(),
  category: Category.nullable(),
  incidentDate: z.string().nullable(),
  supportingUrls: z.array(z.string()),
  editorContext: z.string(),
  riskLevel: RiskLevel,
  riskReasons: z.array(z.string()),
  aiStatus: AiStatus,
  origin: z.enum(['citizen', 'publisher']),
  possibleDuplicateIds: z.array(z.string()),
  article: ArticleSummary.nullable(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
  timeline: z.array(SubmissionEvent),
  /** Only for editors. */
  reporter: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  /** Only for editors: the reporter's track record (the reporter sees their own on their page). */
  reporterTrackRecord: TrackRecord.nullable(),
  /** The reporter's appeal against a rejection, if any. */
  appeal: z.object({ status: z.enum(['open', 'upheld', 'overturned']), note: z.string(), decisionNote: z.string().nullable(), createdAt: z.string(), decidedAt: z.string().nullable() }).nullable(),
  /** Last day a rejected submission can be appealed (null when it cannot be). */
  appealUntil: z.string().nullable(),
});
export type Submission = z.infer<typeof Submission>;

export const SubmissionResponse = z.object({ submission: Submission });
export type SubmissionResponse = z.infer<typeof SubmissionResponse>;

export const SubmissionListItem = Submission.pick({
  id: true,
  status: true,
  headline: true,
  language: true,
  location: true,
  riskLevel: true,
  aiStatus: true,
  origin: true,
  submittedAt: true,
  updatedAt: true,
}).extend({ possibleDuplicateCount: z.number() });
export type SubmissionListItem = z.infer<typeof SubmissionListItem>;

export const SubmissionListResponse = z.object({ items: z.array(SubmissionListItem), nextCursor: z.string().nullable() });
export type SubmissionListResponse = z.infer<typeof SubmissionListResponse>;

const Url = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Drafts can be incomplete; everything is checked again when submitting. */
export const SaveDraftRequest = z
  .object({
    headline: z.string().trim().max(200).optional(),
    summary: z.string().trim().max(400).optional(),
    body: z.string().trim().max(20_000).optional(),
    language: Language.optional(),
    locationId: ObjectIdString.nullable().optional(),
    categoryId: ObjectIdString.nullable().optional(),
    incidentDate: IsoDate.nullable().optional(),
    supportingUrls: z.array(Url).max(10).optional(),
    editorContext: z.string().trim().max(2000).optional(),
  })
  .strict();
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

export const SubmitRequest = z.object({ responseNote: z.string().trim().max(1000).optional() }).strict();

// ---------- editorial actions ----------
export const EditorNoteRequest = z.object({ note: z.string().trim().min(5).max(1000) }).strict();
export const RejectSubmissionRequest = z
  .object({ reasonCode: RejectionReason, note: z.string().trim().min(5).max(1000) })
  .strict();
export const SetRiskRequest = z
  .object({ riskLevel: RiskLevel, note: z.string().trim().min(5).max(500) })
  .strict();
export const PublishSubmissionRequest = z
  .object({
    trustLabel: TrustLabel,
    // Editors may tidy the text before publishing; the reporter's version stays in the submission history.
    headline: z.string().trim().min(5).max(200).optional(),
    summary: z.string().trim().min(10).max(400).optional(),
    body: z.string().trim().min(20).max(20_000).optional(),
    deadline: DeadlineDate.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((p) => p.trustLabel !== 'official_unverified', {
    path: ['trustLabel'],
    message: 'Citizen reports cannot carry the official-source label',
  });
export type PublishSubmissionRequest = z.infer<typeof PublishSubmissionRequest>;

export const QueueQuery = z.object({
  status: z.enum(['submitted', 'in_review', 'needs_info', 'returned', 'rejected', 'published']).default('submitted'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

// ---------- publishers ----------
export const PUBLISHER_STATUSES = ['onboarding', 'active', 'suspended'] as const;
export const PublisherStatus = z.enum(PUBLISHER_STATUSES);

export const PublisherOrg = z.object({
  id: z.string(),
  name: z.string(),
  status: PublisherStatus,
  jurisdictions: z.array(LocationSummary),
  allowedCategories: z.array(Category),
  officialDomains: z.array(z.string()),
  memberCount: z.number(),
});
export type PublisherOrg = z.infer<typeof PublisherOrg>;

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'Enter a domain like guntur.ap.gov.in');

export const SavePublisherOrgRequest = z
  .object({
    name: z.string().trim().min(3).max(120),
    status: PublisherStatus,
    jurisdictionIds: z.array(ObjectIdString).min(1).max(50),
    allowedCategoryIds: z.array(ObjectIdString).min(1).max(8),
    officialDomains: z.array(Domain).min(1).max(10),
  })
  .strict();
export type SavePublisherOrgRequest = z.infer<typeof SavePublisherOrgRequest>;

export const PublisherOrgListResponse = z.object({ items: z.array(PublisherOrg) });
export const PublisherOrgResponse = z.object({ org: PublisherOrg });

export const AssignPublisherRequest = z.object({ orgId: ObjectIdString.nullable() }).strict();

export const AnnouncementRequest = z
  .object({
    headline: z.string().trim().min(5).max(200),
    summary: z.string().trim().min(10).max(400),
    body: z.string().trim().min(20).max(20_000),
    language: Language,
    locationId: ObjectIdString,
    categoryId: ObjectIdString,
    originalSourceUrl: Url,
    deadline: IsoDate.optional(),
  })
  .strict();
export type AnnouncementRequest = z.infer<typeof AnnouncementRequest>;

export const AnnouncementResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('published'), article: ArticleSummary }),
  z.object({ outcome: z.literal('sent_for_review'), submissionId: z.string(), reasons: z.array(z.string()) }),
]);
export type AnnouncementResponse = z.infer<typeof AnnouncementResponse>;

// ---------- editor scopes ----------
export const SetScopesRequest = z.object({ locationIds: z.array(ObjectIdString).max(50) }).strict();
export const ScopesResponse = z.object({ locations: z.array(LocationSummary) });

// ---------- content reports ----------
export const REPORT_REASONS = ['misleading', 'false_information', 'hate_or_harassment', 'privacy', 'spam', 'other'] as const;
export const ReportReason = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReason>;

export const CreateReportRequest = z
  .object({ reason: ReportReason, details: z.string().trim().max(1000).optional() })
  .strict();

export const ContentReport = z.object({
  id: z.string(),
  article: ArticleSummary,
  reason: ReportReason,
  details: z.string().nullable(),
  status: z.enum(['open', 'actioned', 'dismissed']),
  resolutionNote: z.string().nullable(),
  createdAt: z.string(),
  reportCountForArticle: z.number(),
});
export type ContentReport = z.infer<typeof ContentReport>;

export const ReportListResponse = z.object({ items: z.array(ContentReport) });
export const ResolveReportRequest = z
  .object({ outcome: z.enum(['actioned', 'dismissed']), note: z.string().trim().min(3).max(1000) })
  .strict();
