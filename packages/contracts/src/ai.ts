import { z } from 'zod';

/** Mirrors services/ai/app/models.py (VerifyResponse). Validated when it arrives from the AI service. */
export const AI_ASSESSMENTS = ['supported', 'contradicted', 'mixed', 'insufficient_evidence', 'not_assessed'] as const;
export const AiAssessment = z.enum(AI_ASSESSMENTS);
export type AiAssessment = z.infer<typeof AiAssessment>;

export const AiSourceType = z.enum(['official_government', 'established_news', 'other']);

export const AiSource = z.object({
  url: z.string(),
  status: z.enum(['fetched', 'blocked', 'robots_disallowed', 'unsupported_type', 'too_large', 'error']),
  detail: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  source_type: AiSourceType,
  reliability_rationale: z.string(),
  published_at: z.string().nullable().optional(),
  retrieved_at: z.string(),
  content_sha256: z.string().nullable().optional(),
});

export const AiEvidence = z.object({
  id: z.string(),
  claim_id: z.string(),
  url: z.string(),
  stance: z.enum(['supports', 'contradicts']),
  excerpt: z.string(),
  excerpt_verified: z.boolean(),
  source_type: AiSourceType,
  reliability_rationale: z.string(),
  published_at: z.string().nullable(),
  retrieved_at: z.string(),
});

export const AiClaim = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['factual', 'opinion', 'prediction']),
  check_worthy: z.boolean(),
  assessment: AiAssessment,
  supporting_evidence_ids: z.array(z.string()),
  contradicting_evidence_ids: z.array(z.string()),
  rationale: z.string(),
  missing_evidence: z.array(z.string()),
  uncertainty: z.string(),
});

export const AiVerifyResult = z.object({
  detected_language: z.enum(['te', 'en', 'mixed', 'unknown']),
  language_matches_declared: z.boolean(),
  claims: z.array(AiClaim),
  evidence: z.array(AiEvidence),
  sources: z.array(AiSource),
  recommendation: z.enum(['standard_review', 'senior_review', 'request_more_info']),
  meta: z.object({
    pipeline_version: z.string(),
    provider: z.string(),
    model: z.string(),
    prompt_versions: z.record(z.string(), z.string()),
    duration_ms: z.number(),
    warnings: z.array(z.string()),
  }),
});
export type AiVerifyResult = z.infer<typeof AiVerifyResult>;

export const VerificationReport = z.object({
  submissionVersion: z.number(),
  status: z.enum(['pending', 'completed', 'failed', 'unavailable']),
  /** Human-readable reason when the analysis is not available. */
  error: z.string().nullable(),
  attempts: z.number(),
  result: AiVerifyResult.nullable(),
  requestedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

export const VerificationResponse = z.object({ report: VerificationReport.nullable() });
export type VerificationResponse = z.infer<typeof VerificationResponse>;

// ---------- assistant ----------
export const AskRequest = z
  .object({
    question: z.string().trim().min(3).max(500),
    articleSlug: z.string().regex(/^[a-z0-9-]{3,80}$/).optional(),
    locationId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
    /** Answer language; "simple" only changes Telugu answers (very plain Telugu). */
    language: z.enum(['te', 'en']).default('te'),
    simple: z.boolean().default(false),
  })
  .strict();
export type AskRequest = z.input<typeof AskRequest>;

export const ASK_STATUSES = ['answered', 'insufficient_information', 'unavailable'] as const;
/** `answer` is empty unless status is "answered"; the app shows its own message for the other statuses. */
export const AskResponse = z.object({
  status: z.enum(ASK_STATUSES),
  answer: z.string(),
  citations: z.array(z.object({ id: z.string(), slug: z.string(), headline: z.string() })),
  generatedBy: z.string().nullable(),
  cached: z.boolean(),
});
export type AskResponse = z.infer<typeof AskResponse>;

/** Mirrors services/ai/app/models.py (AnswerResponse). */
export const AiAnswerResult = z.object({
  status: z.enum(['answered', 'insufficient_information']),
  answer: z.string(),
  cited_article_ids: z.array(z.string()),
  meta: z.object({ provider: z.string(), model: z.string() }).passthrough(),
});
export type AiAnswerResult = z.infer<typeof AiAnswerResult>;
