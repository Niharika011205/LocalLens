import { z } from 'zod';

// ---------- reporter track record ----------
/**
 * Derived only from editorial decisions in the last 180 days, shown to the reporter in full.
 * It changes queue ORDER only: "trusted" reporters get a head start; nobody is pushed back or blocked.
 * Overturned rejections (appeals) are not counted against the reporter.
 */
export const TRACK_TIERS = ['new', 'standard', 'trusted', 'needs_support'] as const;
export const TrackTier = z.enum(TRACK_TIERS);
export type TrackTier = z.infer<typeof TrackTier>;

export const TRACK_RULES = {
  windowDays: 180,
  minDecisions: 3,
  trustedMinDecisions: 5,
  trustedMinPublishedShare: 0.7,
  needsSupportMaxPublishedShare: 0.3,
  trustedHeadStartHours: 12,
} as const;

export const TrackRecord = z.object({
  tier: TrackTier,
  windowDays: z.number(),
  published: z.number(),
  rejected: z.number(),
  rejectedByReason: z.record(z.string(), z.number()),
  returnedForChanges: z.number(),
  corrections: z.number(),
  retractions: z.number(),
  appealsOverturned: z.number(),
  queueHeadStartHours: z.number(),
});
export type TrackRecord = z.infer<typeof TrackRecord>;
export const TrackRecordResponse = z.object({ trackRecord: TrackRecord });
export type TrackRecordResponse = z.infer<typeof TrackRecordResponse>;
