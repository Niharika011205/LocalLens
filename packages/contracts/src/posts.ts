import { z } from 'zod';
import { Language, ObjectIdString } from './common';
import { ArticleSummary } from './articles';

/**
 * Quick posts (short news, like a news-card app): a reporter writes a headline and a short summary, adds a photo,
 * and it goes live at once, labelled "not checked by editors". Readers report problems; enough reports from
 * different people remove it automatically.
 */
export const POST_SUMMARY_MAX = 560; // about 80 words: fits one card on a phone

/** The text fields of the multipart form (the photo is the "photo" file field). */
export const CreatePostFields = z
  .object({
    headline: z.string().trim().min(5, 'Headline is too short').max(120, 'Keep the headline under 120 characters'),
    summary: z.string().trim().min(20, 'Write at least a sentence').max(POST_SUMMARY_MAX, `Keep it under ${POST_SUMMARY_MAX} characters`),
    body: z.string().trim().max(20_000).optional(),
    language: Language,
    locationId: ObjectIdString,
    categoryId: ObjectIdString,
  })
  .strict();
export type CreatePostFields = z.infer<typeof CreatePostFields>;

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Why a post is not live. */
export const POST_HOLD_REASONS = ['needs_review', 'community_reports', 'author_deleted', 'editor_removed'] as const;
export const PostHoldReason = z.enum(POST_HOLD_REASONS);
export type PostHoldReason = z.infer<typeof PostHoldReason>;

export const MyPost = ArticleSummary.extend({
  holdReason: PostHoldReason.nullable(),
  openReports: z.number(),
});
export type MyPost = z.infer<typeof MyPost>;
export const MyPostsResponse = z.object({ items: z.array(MyPost), removeAfterReports: z.number() });
export type MyPostsResponse = z.infer<typeof MyPostsResponse>;
export const CreatePostResponse = z.object({ post: MyPost });
export type CreatePostResponse = z.infer<typeof CreatePostResponse>;

/** For editors: posts that are held or were removed by reports, with the reasons people gave. */
export const HeldPost = MyPost.extend({
  author: z.object({ id: z.string(), displayName: z.string() }),
  reportReasons: z.record(z.string(), z.number()),
});
export type HeldPost = z.infer<typeof HeldPost>;
export const HeldPostsResponse = z.object({ items: z.array(HeldPost) });
export type HeldPostsResponse = z.infer<typeof HeldPostsResponse>;
export const HeldPostDecision = z.object({ decision: z.enum(['restore', 'keep_removed']), note: z.string().trim().min(5).max(500) }).strict();
export type HeldPostDecision = z.infer<typeof HeldPostDecision>;

export const ReportResult = z.object({ message: z.string(), removed: z.boolean() });
export type ReportResult = z.infer<typeof ReportResult>;

/** Public product settings the app needs to explain itself (GET /config). */
export const PublicConfig = z.object({
  reporterSelfSignup: z.boolean(),
  removeAfterReports: z.number(),
  /** False when no AI service is configured (e.g. free hosting): the app hides "Ask AI". */
  assistant: z.boolean(),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
