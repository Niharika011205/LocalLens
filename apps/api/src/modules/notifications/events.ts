import type { Types } from 'mongoose';
import { enqueue } from '../jobs/jobs';

/**
 * Publishing raises these; the notifications module handles them in the background.
 * Kept separate so publishing depends only on the job queue, not on notifications.
 *
 * Enqueue failures never fail the editor's action: a sweeper re-raises recent events (dedupe keys make that safe).
 */
export const NOTIFY_NEW_ARTICLE = 'notify_new_article';
export const NOTIFY_ARTICLE_CHANGED = 'notify_article_changed';
export const NOTIFY_DEADLINES = 'notify_deadlines';

export async function articlePublished(articleId: Types.ObjectId): Promise<void> {
  await enqueue(NOTIFY_NEW_ARTICLE, { articleId: articleId.toHexString() }, { dedupeKey: `notify-new:${articleId.toHexString()}` }).catch(() => undefined);
}

export async function articleChanged(articleId: Types.ObjectId, revision: number, change: 'corrected' | 'retracted'): Promise<void> {
  const id = articleId.toHexString();
  await enqueue(NOTIFY_ARTICLE_CHANGED, { articleId: id, revision, change }, { dedupeKey: `notify-change:${id}:${revision}` }).catch(() => undefined);
}

/** Calendar date in India (all LocalLens deadlines are Indian dates), as the UTC-midnight Date used for storage. */
export function istDate(offsetDays = 0, now = Date.now()): Date {
  const day = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00Z`) + offsetDays * 86_400_000);
}
