import { Router } from 'express';
import { Schema, Types, model } from 'mongoose';
import {
  CreateReportRequest,
  ObjectIdString,
  REPORT_REASONS,
  ResolveReportRequest,
  type ContentReport,
  type ReportReason,
  type ReportResult,
} from '@locallens/contracts';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { ArticleModel } from '../publishing/article.model';
import { toArticleSummaries } from '../publishing/articles.service';

interface Report {
  articleId: Types.ObjectId;
  reporterUserId: Types.ObjectId;
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  resolution: { note: string; by: Types.ObjectId; at: Date } | null;
  createdAt: Date;
}
const reportSchema = new Schema<Report>(
  {
    articleId: { type: Schema.Types.ObjectId, required: true },
    reporterUserId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: { type: String, default: null },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    resolution: { type: { note: String, by: Schema.Types.ObjectId, at: Date }, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// One report per person per article: repeated reports from one account do not inflate counts.
reportSchema.index({ articleId: 1, reporterUserId: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: 1 });
export const ContentReportModel = model<Report>('ContentReport', reportSchema, 'content_reports');

/**
 * A quick post (not checked by editors) reported by `threshold` different readers is removed at once — atomically, so
 * exactly once. Editor-checked articles are never removed automatically: their reports go to the editors' queue.
 * Returns true when this report removed the post.
 */
export async function onReported(articleId: Types.ObjectId, threshold: number): Promise<boolean> {
  const article = await ArticleModel.findById(articleId, { trustLabel: 1, status: 1 });
  // Unchecked content only: reporter posts and headlines imported from other sites.
  if (!article || !['reporter_post', 'external_source'].includes(article.trustLabel) || article.status !== 'published') return false;
  const open = await ContentReportModel.countDocuments({ articleId, status: 'open' });
  if (open < threshold) return false;
  const removed = await ArticleModel.updateOne({ _id: articleId, status: 'published' }, { $set: { status: 'unpublished', holdReason: 'community_reports' } });
  return removed.modifiedCount === 1;
}

/** Readers report a published article. */
export function articleReportsRouter(deps: { removeAfterReports: number }): Router {
  const r = Router();
  r.post('/:id/reports', requireAuth, async (req, res) => {
    const { reason, details } = CreateReportRequest.parse(req.body);
    const articleId = new Types.ObjectId(ObjectIdString.parse(req.params.id));
    const target = await ArticleModel.findOne({ _id: articleId, status: { $in: ['published', 'retracted'] } }, { createdBy: 1 });
    if (!target) throw Errors.notFound('Article not found');
    const user = currentUser(req);
    if (target.createdBy.equals(user._id)) throw Errors.conflict('You cannot report your own post');
    try {
      const report = await ContentReportModel.create({ articleId, reporterUserId: user._id, reason, details: details ?? null });
      await audit(req, { action: 'moderation.report_created', actorId: user._id, targetType: 'article', targetId: String(articleId), metadata: { reason, reportId: report.id } });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Errors.conflict('You have already reported this article');
      throw err;
    }
    const removed = await onReported(articleId, deps.removeAfterReports);
    if (removed) {
      await audit(req, { action: 'post.auto_removed', targetType: 'article', targetId: String(articleId), metadata: { threshold: deps.removeAfterReports } });
    }
    res.status(201).json({
      message: removed ? 'Thank you. Enough people reported this post, so it has been removed.' : 'Thank you for reporting this.',
      removed,
    } satisfies ReportResult);
  });
  return r;
}

/** Editors and admins work through open reports. Reporter identities are not shown, to protect them from retaliation. */
export function moderationRouter(): Router {
  const r = Router();
  r.use(requireRole('editor', 'senior_editor', 'admin'));

  r.get('/reports', async (req, res) => {
    const { status } = z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open') }).parse(req.query);
    const reports = await ContentReportModel.find({ status }).sort({ createdAt: status === 'open' ? 1 : -1 }).limit(100);
    const articles = await ArticleModel.find({ _id: { $in: reports.map((x) => x.articleId) } });
    const summaries = new Map((await toArticleSummaries(articles)).map((a) => [a.id, a]));
    const counts = await ContentReportModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { articleId: { $in: reports.map((x) => x.articleId) } } },
      { $group: { _id: '$articleId', n: { $sum: 1 } } },
    ]);
    const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
    const items: ContentReport[] = reports
      .filter((x) => summaries.has(String(x.articleId)))
      .map((x) => ({
        id: x.id as string,
        article: summaries.get(String(x.articleId))!,
        reason: x.reason,
        details: x.details,
        status: x.status,
        resolutionNote: x.resolution?.note ?? null,
        createdAt: x.createdAt.toISOString(),
        reportCountForArticle: countBy.get(String(x.articleId)) ?? 1,
      }));
    res.json({ items });
  });

  r.post('/reports/:id/resolve', async (req, res) => {
    const { outcome, note } = ResolveReportRequest.parse(req.body);
    const user = currentUser(req);
    const report = await ContentReportModel.findOneAndUpdate(
      { _id: ObjectIdString.parse(req.params.id), status: 'open' },
      { $set: { status: outcome, resolution: { note, by: user._id, at: new Date() } } },
      { new: true },
    );
    if (!report) throw Errors.conflict('This report is not open');
    await audit(req, { action: `moderation.report_${outcome}`, actorId: user._id, targetType: 'article', targetId: String(report.articleId), metadata: { reportId: report.id, note } });
    res.json({ message: 'Resolved' });
  });

  return r;
}
