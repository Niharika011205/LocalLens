import { z } from 'zod';
import { ObjectIdString } from './common';

export const NOTIFICATION_KINDS = ['new_article', 'article_corrected', 'article_retracted', 'deadline_soon'] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationItem = z.object({
  id: z.string(),
  kind: NotificationKind,
  article: z.object({ id: z.string(), slug: z.string(), headline: z.string(), deadline: z.string().nullable() }),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: ObjectIdString.optional(),
});
export const NotificationsResponse = z.object({
  items: z.array(NotificationItem),
  nextCursor: z.string().nullable(),
  unreadCount: z.number(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

export const UnreadCountResponse = z.object({ unreadCount: z.number() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponse>;

/** Without ids, marks everything read. */
export const MarkReadRequest = z.object({ ids: z.array(ObjectIdString).min(1).max(100).optional() }).strict();
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
