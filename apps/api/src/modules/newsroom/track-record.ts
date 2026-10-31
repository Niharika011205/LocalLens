import type { Types } from 'mongoose';
import { TRACK_RULES, type TrackRecord, type TrackTier } from '@locallens/contracts';
import { ArticleModel } from '../publishing/article.model';
import { AppealModel, EditorialEventModel, SubmissionModel } from './submission.model';

/**
 * A reporter's track record: a plain count of editorial outcomes, never a hidden score.
 *
 * Rules (also shown to the reporter, see TRACK_RULES):
 * - Window: decisions in the last 180 days, citizen reports only.
 * - Fewer than 3 decisions: "new". Any retraction: at most "standard".
 * - 5+ decisions and at least 70% published: "trusted" — a 12-hour head start in the review queue.
 * - 5+ decisions and under 30% published: "needs support" — shown to editors so they can help; no penalty.
 * - A rejection overturned on appeal goes back to review, so it never counts as a rejection.
 */
export async function trackRecord(reporterId: Types.ObjectId, now = Date.now()): Promise<TrackRecord> {
  const since = new Date(now - TRACK_RULES.windowDays * 86_400_000);
  const decided = await SubmissionModel.find(
    { reporterId, origin: 'citizen', status: { $in: ['published', 'rejected'] }, updatedAt: { $gte: since } },
    { status: 1, articleId: 1 },
  ).lean();
  const published = decided.filter((s) => s.status === 'published');
  const rejectedIds = decided.filter((s) => s.status === 'rejected').map((s) => s._id);

  const [rejections, returned, articles, overturned] = await Promise.all([
    EditorialEventModel.find({ submissionId: { $in: rejectedIds }, action: 'rejected' }, { submissionId: 1, reasonCode: 1, at: 1 }).sort({ at: 1 }).lean(),
    SubmissionModel.find({ reporterId, origin: 'citizen' }, { _id: 1 })
      .lean()
      .then((all) => EditorialEventModel.countDocuments({ submissionId: { $in: all.map((s) => s._id) }, action: 'returned', at: { $gte: since } })),
    ArticleModel.find({ _id: { $in: published.map((s) => s.articleId).filter(Boolean) } }, { correctionCount: 1, status: 1 }).lean(),
    AppealModel.countDocuments({ reporterId, status: 'overturned', decidedAt: { $gte: since } }),
  ]);

  // The latest rejection of each submission decides its reason.
  const reasonBySubmission = new Map(rejections.map((e) => [e.submissionId.toHexString(), e.reasonCode ?? 'other']));
  const rejectedByReason: Record<string, number> = {};
  for (const reason of reasonBySubmission.values()) rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;

  const retractions = articles.filter((a) => a.status === 'retracted').length;
  const total = published.length + rejectedIds.length;
  const share = total ? published.length / total : 0;
  let tier: TrackTier = 'standard';
  if (total < TRACK_RULES.minDecisions) tier = 'new';
  else if (total >= TRACK_RULES.trustedMinDecisions && share <= TRACK_RULES.needsSupportMaxPublishedShare) tier = 'needs_support';
  else if (total >= TRACK_RULES.trustedMinDecisions && share >= TRACK_RULES.trustedMinPublishedShare && retractions === 0) tier = 'trusted';

  return {
    tier,
    windowDays: TRACK_RULES.windowDays,
    published: published.length,
    rejected: rejectedIds.length,
    rejectedByReason,
    returnedForChanges: returned,
    corrections: articles.reduce((n, a) => n + (a.correctionCount ?? 0), 0),
    retractions,
    appealsOverturned: overturned,
    queueHeadStartHours: tier === 'trusted' ? TRACK_RULES.trustedHeadStartHours : 0,
  };
}

/** Position in the review queue: the submission time, minus the head start (if any). */
export function queuePosition(submittedAt: Date, record: TrackRecord): Date {
  return new Date(submittedAt.getTime() - record.queueHeadStartHours * 3_600_000);
}
