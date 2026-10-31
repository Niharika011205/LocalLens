import type { Types } from 'mongoose';
import { SubmissionModel, type SubmissionDoc } from './submission.model';

/**
 * Finds submissions that may describe the same event: same district, submitted within a week of each other, and
 * sharing most of their words (Jaccard similarity of headline + summary words).
 *
 * This is a deterministic first version: it catches re-posts and near-copies, not paraphrases or the same event
 * reported in another language — that needs multilingual embeddings (AI phase). Duplicates are shown to editors as
 * context only: several reports of the same claim raise priority, never trust.
 */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const THRESHOLD = 0.45;

export function wordSet(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFC')
      .toLowerCase()
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export async function findDuplicates(sub: SubmissionDoc): Promise<Types.ObjectId[]> {
  if (!sub.districtId || !sub.submittedAt) return [];
  const t = sub.submittedAt.getTime();
  const candidates = await SubmissionModel.find(
    {
      _id: { $ne: sub._id },
      districtId: sub.districtId,
      status: { $nin: ['draft', 'withdrawn'] },
      submittedAt: { $gte: new Date(t - WINDOW_MS), $lte: new Date(t + WINDOW_MS) },
    },
    { headline: 1, summary: 1 },
  ).limit(200);
  const mine = wordSet(`${sub.headline} ${sub.summary}`);
  return candidates.filter((c) => jaccard(mine, wordSet(`${c.headline} ${c.summary}`)) >= THRESHOLD).map((c) => c._id);
}
