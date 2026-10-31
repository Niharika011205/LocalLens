import { Router } from 'express';
import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import {
  MarkReadRequest,
  NOTIFICATION_KINDS,
  NotificationsQuery,
  type NotificationItem,
  type NotificationKind,
  type NotificationsResponse,
  type UnreadCountResponse,
} from '@locallens/contracts';
import { currentUser, requireAuth } from '../../middleware/auth';
import { FollowModel, SavedArticleModel } from '../engagement/engagement';
import { LocationModel } from '../geo/location.model';
import { enqueue, registerJobHandler, registerSweeper, type JobDoc } from '../jobs/jobs';
import { ArticleModel, ArticleRevisionModel, type ArticleDoc } from '../publishing/article.model';
import { articleChanged, articlePublished, istDate, NOTIFY_ARTICLE_CHANGED, NOTIFY_DEADLINES, NOTIFY_NEW_ARTICLE } from './events';

/**
 * In-app notifications (no email/SMS in the pilot: zero sending cost, nothing to leak to a third party).
 *
 * - new_article: people who follow the article's place (same inside/above rule as the feed) or its topic.
 * - article_corrected / article_retracted: people who saved it or were notified about it — a correction should
 *   reach everyone who may have acted on the original.
 * - deadline_soon: once, when a deadline is 3 days away or less, for people who saved the article or follow it.
 *
 * Fan-out runs in background jobs. A unique key per (user, kind, article, revision) makes retries and
 * re-runs harmless: nobody is notified twice about the same thing.
 */

const KEEP_DAYS = 90;
const REMIND_DAYS_BEFORE = 3;
const BATCH = 1000;

interface Notification {
  userId: Types.ObjectId;
  kind: NotificationKind;
  articleId: Types.ObjectId;
  /** Which article revision (or, for deadline reminders, which deadline date as yyyymmdd) this is about. */
  revision: number;
  readAt: Date | null;
  createdAt: Date;
}
const notificationSchema = new Schema<Notification>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    articleId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ userId: 1, kind: 1, articleId: 1, revision: 1 }, { unique: true });
notificationSchema.index({ userId: 1, _id: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ articleId: 1, kind: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 86_400 });
export const NotificationModel = model<Notification>('Notification', notificationSchema, 'notifications');
export type NotificationDoc = HydratedDocument<Notification>;

// ---------- recipients ----------
async function followersOf(article: ArticleDoc): Promise<Types.ObjectId[]> {
  // Places at or above the article's place (it happened inside them) and places below it (it applies to them).
  const below = await LocationModel.find({ ancestorIds: article.locationId }, { _id: 1 }).lean();
  const places = [...article.locationLineage, ...below.map((l) => l._id)];
  const follows = await FollowModel.find(
    { $or: [{ targetType: 'location', targetId: { $in: places } }, { targetType: 'category', targetId: article.categoryId }] },
    { userId: 1 },
  ).lean();
  return follows.map((f) => f.userId);
}

async function saversOf(articleId: Types.ObjectId): Promise<Types.ObjectId[]> {
  return (await SavedArticleModel.find({ articleId }, { userId: 1 }).lean()).map((s) => s.userId);
}

async function notify(userIds: Types.ObjectId[], kind: NotificationKind, articleId: Types.ObjectId, revision: number, exclude?: Types.ObjectId) {
  const unique = [...new Map(userIds.map((u) => [u.toHexString(), u])).values()].filter((u) => !exclude?.equals(u));
  for (let i = 0; i < unique.length; i += BATCH) {
    const docs = unique.slice(i, i + BATCH).map((userId) => ({ userId, kind, articleId, revision }));
    try {
      await NotificationModel.insertMany(docs, { ordered: false });
    } catch (err) {
      // Duplicates mean "already notified" (a retry or a re-run); anything else is a real failure.
      const writeErrors = (err as { writeErrors?: { code?: number }[] }).writeErrors;
      if (!writeErrors?.length || writeErrors.some((e) => e.code !== 11000)) throw err;
    }
  }
  return unique.length;
}

const deadlineKey = (d: Date) => Number(d.toISOString().slice(0, 10).replaceAll('-', ''));

let cleanedImportAlerts = false;

// ---------- jobs ----------
export function configureNotifications(): void {
  registerJobHandler(NOTIFY_NEW_ARTICLE, {
    async run(job: JobDoc) {
      const article = await ArticleModel.findById((job.payload as { articleId: string }).articleId);
      if (!article || article.status !== 'published') return; // unpublished or retracted before we got to it
      // Headlines imported from other sites never alert followers (hundreds a day would bury real local news).
      if (article.sourceType === 'external') return;
      await notify(await followersOf(article), 'new_article', article._id, 1, article.createdBy);
    },
  });

  registerJobHandler(NOTIFY_ARTICLE_CHANGED, {
    async run(job: JobDoc) {
      const { articleId, revision, change } = job.payload as { articleId: string; revision: number; change: 'corrected' | 'retracted' };
      const article = await ArticleModel.findById(articleId);
      if (!article) return;
      const told = await NotificationModel.find({ articleId: article._id, kind: 'new_article' }, { userId: 1 }).lean();
      await notify([...(await saversOf(article._id)), ...told.map((n) => n.userId)], change === 'retracted' ? 'article_retracted' : 'article_corrected', article._id, revision);
    },
  });

  registerJobHandler(NOTIFY_DEADLINES, {
    async run() {
      const soon = await ArticleModel.find({ status: 'published', deadline: { $gte: istDate(), $lte: istDate(REMIND_DAYS_BEFORE) } }).limit(500);
      for (const article of soon) {
        const users = [...(await saversOf(article._id)), ...(await followersOf(article))];
        await notify(users, 'deadline_soon', article._id, deadlineKey(article.deadline as Date));
      }
    },
  });

  registerSweeper('notifications', async () => {
    // Once a day (India date): deadline reminders.
    await enqueue(NOTIFY_DEADLINES, {}, { dedupeKey: `deadlines:${istDate().toISOString().slice(0, 10)}` });
    // Repair: re-raise recent events in case queueing failed when the editor acted (dedupe keys make this safe).
    const since = new Date(Date.now() - 30 * 60_000);
    for (const a of await ArticleModel.find({ firstPublishedAt: { $gte: since }, sourceType: { $ne: 'external' } }, { _id: 1 }).limit(200).lean()) await articlePublished(a._id);
    // One-time clean-up after an earlier version alerted followers about imported headlines.
    if (!cleanedImportAlerts) {
      cleanedImportAlerts = true;
      const imported = await ArticleModel.find({ sourceType: 'external' }, { _id: 1 }).lean();
      await NotificationModel.deleteMany({ kind: 'new_article', articleId: { $in: imported.map((a) => a._id) } });
    }
    const changes = await ArticleRevisionModel.find({ createdAt: { $gte: since }, changeKind: { $in: ['correction', 'clarification', 'retraction'] } }, { articleId: 1, revisionNumber: 1, changeKind: 1 })
      .limit(200)
      .lean();
    for (const c of changes) await articleChanged(c.articleId, c.revisionNumber, c.changeKind === 'retraction' ? 'retracted' : 'corrected');
  });
}

// ---------- routes (under /me, signed in) ----------
async function toItems(docs: (Notification & { _id: Types.ObjectId })[]): Promise<NotificationItem[]> {
  const articles = await ArticleModel.find({ _id: { $in: docs.map((d) => d.articleId) }, status: { $in: ['published', 'retracted'] } }, { slug: 1, headline: 1, deadline: 1 }).lean();
  const byId = new Map(articles.map((a) => [a._id.toHexString(), a]));
  return docs.flatMap((d) => {
    const a = byId.get(d.articleId.toHexString());
    if (!a) return []; // the article was unpublished: nothing to show
    return [
      {
        id: d._id.toHexString(),
        kind: d.kind,
        article: { id: a._id.toHexString(), slug: a.slug, headline: a.headline, deadline: a.deadline ? a.deadline.toISOString().slice(0, 10) : null },
        createdAt: d.createdAt.toISOString(),
        readAt: d.readAt?.toISOString() ?? null,
      },
    ];
  });
}

export function notificationsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  const unread = (userId: Types.ObjectId) => NotificationModel.countDocuments({ userId, readAt: null });

  r.get('/notifications', async (req, res) => {
    const { limit, cursor } = NotificationsQuery.parse(req.query);
    const userId = currentUser(req)._id;
    const docs = await NotificationModel.find({ userId, ...(cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {}) })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = docs.slice(0, limit);
    res.json({
      items: await toItems(page),
      nextCursor: docs.length > limit ? (page.at(-1)?._id.toHexString() ?? null) : null,
      unreadCount: await unread(userId),
    } satisfies NotificationsResponse);
  });

  r.get('/notifications/unread-count', async (req, res) => {
    res.json({ unreadCount: await unread(currentUser(req)._id) } satisfies UnreadCountResponse);
  });

  r.post('/notifications/read', async (req, res) => {
    const { ids } = MarkReadRequest.parse(req.body ?? {});
    const userId = currentUser(req)._id;
    await NotificationModel.updateMany({ userId, readAt: null, ...(ids ? { _id: { $in: ids.map((id) => new Types.ObjectId(id)) } } : {}) }, { $set: { readAt: new Date() } });
    res.json({ unreadCount: await unread(userId) } satisfies UnreadCountResponse);
  });

  return r;
}
