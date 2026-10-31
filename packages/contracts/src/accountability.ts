import { z } from 'zod';
import { ObjectIdString } from './common';
import { RejectionReason } from './newsroom';

export * from './track-record';

// ---------- appeals ----------
export const APPEAL_WINDOW_DAYS = 14;
export const APPEAL_STATUSES = ['open', 'upheld', 'overturned'] as const;
export const AppealStatus = z.enum(APPEAL_STATUSES);
export type AppealStatus = z.infer<typeof AppealStatus>;

export const AppealRequest = z.object({ note: z.string().trim().min(20, 'Explain why the decision should change').max(1000) }).strict();
export type AppealRequest = z.infer<typeof AppealRequest>;
export const AppealDecisionRequest = z
  .object({ outcome: z.enum(['upheld', 'overturned']), note: z.string().trim().min(5).max(1000) })
  .strict();
export type AppealDecisionRequest = z.infer<typeof AppealDecisionRequest>;

export const Appeal = z.object({
  id: z.string(),
  status: AppealStatus,
  note: z.string(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  submission: z.object({ id: z.string(), headline: z.string(), reasonCode: RejectionReason.nullable(), rejectionNote: z.string().nullable() }),
  /** Only for editors. */
  reporter: z.object({ id: z.string(), displayName: z.string() }).nullable(),
});
export type Appeal = z.infer<typeof Appeal>;
export const AppealResponse = z.object({ appeal: Appeal });
export type AppealResponse = z.infer<typeof AppealResponse>;
export const AppealListQuery = z.object({ status: AppealStatus.default('open'), limit: z.coerce.number().int().min(1).max(50).default(30) });
export const AppealListResponse = z.object({ items: z.array(Appeal) });
export type AppealListResponse = z.infer<typeof AppealListResponse>;

// ---------- admin: operations and audit ----------
export const OpsResponse = z.object({
  generatedAt: z.string(),
  users: z.object({ total: z.number(), byRole: z.record(z.string(), z.number()), suspended: z.number(), pendingReporterRequests: z.number() }),
  newsroom: z.object({
    byStatus: z.record(z.string(), z.number()),
    oldestWaitingHours: z.number().nullable(),
    highRiskWaiting: z.number(),
    openAppeals: z.number(),
    openReports: z.number(),
  }),
  articles: z.object({ published: z.number(), publishedLast7Days: z.number(), correctionsLast7Days: z.number(), retracted: z.number() }),
  jobs: z.object({
    byTypeAndStatus: z.array(z.object({ type: z.string(), status: z.string(), count: z.number() })),
    problems: z.array(z.object({ id: z.string(), type: z.string(), status: z.string(), attempts: z.number(), lastError: z.string().nullable(), updatedAt: z.string() })),
    breakersOpen: z.array(z.string()),
  }),
  ai: z.object({
    configured: z.boolean(),
    verificationsLast7Days: z.record(z.string(), z.number()),
    assistantCachedAnswers: z.number(),
  }),
  notificationsLast24Hours: z.number(),
});
export type OpsResponse = z.infer<typeof OpsResponse>;

export const AuditQuery = z.object({
  action: z.string().trim().max(80).regex(/^[a-z_.]*$/).optional(),
  actorId: ObjectIdString.optional(),
  targetId: z.string().trim().max(80).optional(),
  cursor: ObjectIdString.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AuditItem = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  actor: z.object({ id: z.string(), email: z.string(), displayName: z.string() }).nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditItem = z.infer<typeof AuditItem>;
export const AuditResponse = z.object({ items: z.array(AuditItem), nextCursor: z.string().nullable() });
export type AuditResponse = z.infer<typeof AuditResponse>;
