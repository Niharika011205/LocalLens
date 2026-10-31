import { Router } from 'express';
import multer from 'multer';
import type { Types } from 'mongoose';
import {
  CreatePostFields,
  HeldPostDecision,
  ObjectIdString,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  POST_HOLD_REASONS,
  type CreatePostResponse,
  type HeldPost,
  type HeldPostsResponse,
  type MyPost,
  type MyPostsResponse,
  type PostHoldReason,
} from '@locallens/contracts';
import { z } from 'zod';
import { AppError, Errors } from '../../lib/errors';
import { currentUser, requireRole } from '../../middleware/auth';
import { rateLimit, type RateLimiters } from '../../middleware/rate-limit';
import { audit } from '../audit/audit';
import { CategoryModel } from '../catalog/catalog';
import { UserModel } from '../identity/models';
import { deletePhoto, photoFields, storePhoto } from '../media/media';
import { ContentReportModel } from '../moderation/reports';
import { screenRisk } from '../newsroom/risk';
import { articlePublished } from '../notifications/events';
import { ArticleModel, type ArticleDoc } from '../publishing/article.model';
import { createArticle, toArticleSummaries } from '../publishing/articles.service';

/**
 * Quick posts: short news with a photo that goes live immediately, labelled "posted by a reporter, not checked by
 * editors". Safety nets instead of an editor in front:
 * - the keyword screen holds risky posts (violence, communal tension, accusations…) for an editor first;
 * - readers report problems, and enough different people reporting removes the post automatically
 *   (see onReported); an editor can restore it if the reports were unfair;
 * - posting is rate-limited per reporter.
 */

/** The post's photo is optional; a single file, size-capped before it reaches memory limits. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES, files: 1, fields: 10, fieldSize: 25_000 },
  fileFilter: (_req, file, cb) =>
    (PHOTO_TYPES as readonly string[]).includes(file.mimetype)
      ? cb(null, true)
      : cb(new AppError(400, 'VALIDATION_FAILED', 'Use a JPEG, PNG or WebP photo', [{ path: 'photo', message: 'Use a JPEG, PNG or WebP photo' }])),
}).single('photo');

export const isQuickPost = (a: Pick<ArticleDoc, 'trustLabel'>) => a.trustLabel === 'reporter_post';

async function toMyPosts(docs: ArticleDoc[]): Promise<MyPost[]> {
  const [summaries, counts] = await Promise.all([
    toArticleSummaries(docs),
    ContentReportModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { articleId: { $in: docs.map((d) => d._id) }, status: 'open' } },
      { $group: { _id: '$articleId', n: { $sum: 1 } } },
    ]),
  ]);
  const open = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
  return summaries.map((s, i) => ({ ...s, holdReason: (docs[i]!.holdReason as PostHoldReason | null) ?? null, openReports: open.get(s.id) ?? 0 }));
}

export function postsRouter(deps: { limiters: RateLimiters; removeAfterReports: number }): Router {
  const r = Router();
  r.use(requireRole('reporter', 'editor', 'senior_editor', 'admin'));

  r.post(
    '/',
    rateLimit(deps.limiters.posts, { failClosed: false, key: (req) => currentUser(req)._id.toHexString() }),
    (req, res, next) =>
      upload(req, res, (err: unknown) => {
        if (err instanceof AppError) return next(err);
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'The photo is too large (max 8 MB)'));
        if (err) return next(new AppError(400, 'VALIDATION_FAILED', 'The form could not be read'));
        next();
      }),
    async (req, res) => {
      const user = currentUser(req);
      const fields = CreatePostFields.parse({ ...req.body, ...(req.body?.body === '' ? { body: undefined } : {}) });
      const category = await CategoryModel.findById(fields.categoryId, { slug: 1 });
      if (!category) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category', [{ path: 'categoryId', message: 'Unknown category' }]);

      // Every post goes live at once; readers' reports are the check (REPORTS_TO_REMOVE). Sensitive topics are only
      // noted in the audit log so staff can look back if a post is reported.
      const risk = screenRisk(`${fields.headline} ${fields.summary} ${fields.body ?? ''}`, category.slug);
      const photo = req.file ? await storePhoto(req.file.buffer, user._id) : null;
      const article = await createArticle(
        {
          headline: fields.headline,
          summary: fields.summary,
          body: fields.body || fields.summary,
          language: fields.language,
          locationId: fields.locationId,
          categoryId: fields.categoryId,
          trustLabel: 'reporter_post',
          sourceType: 'citizen',
        },
        user._id,
        photoFields(photo),
      );
      await audit(req, { action: 'post.created', actorId: user._id, targetType: 'article', targetId: article.id, metadata: { riskReasons: risk.reasons, photo: photo?.kind ?? null } });
      res.status(201).json({ post: (await toMyPosts([article]))[0]! } satisfies CreatePostResponse);
    },
  );

  r.get('/mine', async (req, res) => {
    const docs = await ArticleModel.find({ createdBy: currentUser(req)._id, trustLabel: 'reporter_post' }).sort({ firstPublishedAt: -1 }).limit(100);
    res.json({ items: await toMyPosts(docs), removeAfterReports: deps.removeAfterReports } satisfies MyPostsResponse);
  });

  /** Authors can take down their own post at any time (it is hidden, like every removal). */
  r.delete('/:id', async (req, res) => {
    const user = currentUser(req);
    const updated = await ArticleModel.findOneAndUpdate(
      { _id: ObjectIdString.parse(req.params.id), createdBy: user._id, trustLabel: 'reporter_post', status: 'published' },
      { $set: { status: 'unpublished', holdReason: 'author_deleted' } },
      { new: true },
    );
    if (!updated) throw Errors.notFound('Post not found');
    await deletePhoto(updated); // the author wants it gone: the photo is deleted, not just hidden
    await ArticleModel.updateOne({ _id: updated._id }, { $set: photoFields(null) });
    await audit(req, { action: 'post.deleted_by_author', actorId: user._id, targetType: 'article', targetId: updated.id });
    res.status(204).end();
  });

  return r;
}

/** Editors: posts waiting for a check, or removed by readers' reports — restore them or keep them removed. */
export function heldPostsRouter(): Router {
  const r = Router();
  r.use(requireRole('editor', 'senior_editor', 'admin'));

  r.get('/posts', async (req, res) => {
    const reason = z.enum(POST_HOLD_REASONS).default('community_reports').parse(req.query.reason);
    const docs = await ArticleModel.find({ trustLabel: 'reporter_post', status: 'unpublished', holdReason: reason }).sort({ updatedAt: -1 }).limit(100);
    const [posts, authors, reasons] = await Promise.all([
      toMyPosts(docs),
      UserModel.find({ _id: { $in: docs.map((d) => d.createdBy) } }, { displayName: 1 }).lean(),
      ContentReportModel.aggregate<{ _id: { a: Types.ObjectId; r: string }; n: number }>([
        { $match: { articleId: { $in: docs.map((d) => d._id) } } },
        { $group: { _id: { a: '$articleId', r: '$reason' }, n: { $sum: 1 } } },
      ]),
    ]);
    const names = new Map(authors.map((a) => [a._id.toHexString(), a.displayName]));
    const items: HeldPost[] = posts.map((p, i) => ({
      ...p,
      author: { id: docs[i]!.createdBy.toHexString(), displayName: names.get(docs[i]!.createdBy.toHexString()) ?? '' },
      reportReasons: Object.fromEntries(reasons.filter((g) => g._id.a.toHexString() === p.id).map((g) => [g._id.r, g.n])),
    }));
    res.json({ items } satisfies HeldPostsResponse);
  });

  r.post('/posts/:id/decide', async (req, res) => {
    const editor = currentUser(req);
    const { decision, note } = HeldPostDecision.parse(req.body);
    const article = await ArticleModel.findOne({ _id: ObjectIdString.parse(req.params.id), trustLabel: 'reporter_post', status: 'unpublished', holdReason: { $in: ['needs_review', 'community_reports'] } });
    if (!article) throw Errors.notFound('Post not found');
    const resolution = { note, by: editor._id, at: new Date() };
    if (decision === 'restore') {
      await ArticleModel.updateOne({ _id: article._id }, { $set: { status: 'published', holdReason: null } });
      // The reports were judged unfair: they no longer count towards removal.
      await ContentReportModel.updateMany({ articleId: article._id, status: 'open' }, { $set: { status: 'dismissed', resolution } });
      if (article.holdReason === 'needs_review') await articlePublished(article._id); // followers hear about it now
    } else {
      await deletePhoto(article);
      await ArticleModel.updateOne({ _id: article._id }, { $set: { holdReason: 'editor_removed', ...photoFields(null) } });
      await ContentReportModel.updateMany({ articleId: article._id, status: 'open' }, { $set: { status: 'actioned', resolution } });
    }
    await audit(req, { action: `post.${decision}`, actorId: editor._id, targetType: 'article', targetId: article.id, metadata: { from: article.holdReason, note } });
    res.json({ message: decision === 'restore' ? 'Post restored' : 'Post kept removed' });
  });

  return r;
}
