import { Types, type FilterQuery } from 'mongoose';
import {
  APPEAL_WINDOW_DAYS,
  type PublishSubmissionRequest,
  type RejectionReason,
  type RiskLevel,
  type SaveDraftRequest,
  type Submission as SubmissionDto,
  type SubmissionListItem,
  type SubmissionStatus,
} from '@locallens/contracts';
import { z } from 'zod';
import { AppError, Errors } from '../../lib/errors';
import { CategoryModel, toCategory } from '../catalog/catalog';
import { toSummary } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import type { UserDoc } from '../identity/models';
import { UserModel } from '../identity/models';
import { ArticleModel } from '../publishing/article.model';
import { createArticle, toArticleSummaries } from '../publishing/articles.service';
import { findDuplicates } from './duplicates';
import { screenRisk } from './risk';
import { queuePosition, trackRecord } from './track-record';
import {
  AppealModel,
  EditorialEventModel,
  SubmissionModel,
  SubmissionVersionModel,
  type EditorialEvent,
  type Submission,
  type SubmissionDoc,
} from './submission.model';

const EDITABLE: SubmissionStatus[] = ['draft', 'returned', 'needs_info'];
const PUBLISH_LOCK_MS = 60_000;

/** Hook for the AI pipeline (Phase 4): called after a submission is submitted. Replaced at startup when AI is enabled. */
export type SubmittedHook = (sub: SubmissionDoc) => Promise<void>;
let onSubmitted: SubmittedHook = async () => undefined;
export function setSubmittedHook(hook: SubmittedHook): void {
  onSubmitted = hook;
}

// ---------- access policy (object level) ----------
export function isEditor(user: UserDoc): boolean {
  return user.roles.some((r) => r === 'editor' || r === 'senior_editor' || r === 'admin');
}
export function isSeniorEditor(user: UserDoc): boolean {
  return user.roles.some((r) => r === 'senior_editor' || r === 'admin');
}

/** Editors with scopes only see submissions inside those places. No scopes = whole platform (pilot default). */
export function scopeFilter(user: UserDoc): FilterQuery<Submission> {
  return user.editorScopes?.length ? { locationLineage: { $in: user.editorScopes } } : {};
}

export function editorCanAccess(user: UserDoc, sub: SubmissionDoc): boolean {
  if (!isEditor(user)) return false;
  if (!user.editorScopes?.length) return true;
  return sub.locationLineage.some((l) => user.editorScopes.some((s) => s.equals(l)));
}

export async function getOwnSubmission(user: UserDoc, id: string): Promise<SubmissionDoc> {
  const sub = await SubmissionModel.findById(id);
  // 404, not 403: do not confirm that someone else's submission exists.
  if (!sub || !sub.reporterId.equals(user._id)) throw Errors.notFound('Submission not found');
  return sub;
}

export async function getSubmissionForEditor(user: UserDoc, id: string): Promise<SubmissionDoc> {
  const sub = await SubmissionModel.findById(id);
  if (!sub || sub.status === 'draft' || !editorCanAccess(user, sub)) throw Errors.notFound('Submission not found');
  return sub;
}

// ---------- shaping ----------
export async function toSubmissionDto(sub: SubmissionDoc, viewer: 'reporter' | 'editor'): Promise<SubmissionDto> {
  const [location, category, events, article, reporter, appeal, record] = await Promise.all([
    sub.locationId ? LocationModel.findById(sub.locationId) : null,
    sub.categoryId ? CategoryModel.findById(sub.categoryId) : null,
    EditorialEventModel.find({ submissionId: sub._id, ...(viewer === 'reporter' ? { visibleToReporter: true } : {}) }).sort({ at: 1, _id: 1 }),
    sub.articleId ? ArticleModel.findOne({ _id: sub.articleId, status: { $in: ['published', 'retracted'] } }) : null,
    viewer === 'editor' ? UserModel.findById(sub.reporterId, { displayName: 1 }) : null,
    AppealModel.findOne({ submissionId: sub._id }).lean(),
    viewer === 'editor' && sub.origin === 'citizen' ? trackRecord(sub.reporterId) : null,
  ]);
  const rejectedAt = sub.status === 'rejected' ? events.filter((e) => e.action === 'rejected').at(-1)?.at : undefined;
  const appealUntil = rejectedAt && !appeal && sub.origin === 'citizen' ? new Date(rejectedAt.getTime() + APPEAL_WINDOW_DAYS * 86_400_000) : null;
  return {
    id: sub.id as string,
    status: sub.status,
    version: sub.version,
    headline: sub.headline,
    summary: sub.summary,
    body: sub.body,
    language: sub.language,
    location: location ? await toSummary(location) : null,
    category: category ? toCategory(category) : null,
    incidentDate: sub.incidentDate ? sub.incidentDate.toISOString().slice(0, 10) : null,
    supportingUrls: [...sub.supportingUrls],
    editorContext: sub.editorContext,
    riskLevel: sub.riskLevel,
    riskReasons: viewer === 'editor' ? [...sub.riskReasons] : [],
    aiStatus: sub.aiStatus,
    origin: sub.origin,
    possibleDuplicateIds: viewer === 'editor' ? sub.possibleDuplicateIds.map(String) : [],
    article: article ? (await toArticleSummaries([article]))[0]! : null,
    submittedAt: sub.submittedAt?.toISOString() ?? null,
    updatedAt: sub.updatedAt.toISOString(),
    timeline: events.map((e) => ({
      action: e.action,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      reasonCode: e.reasonCode,
      note: e.note,
      actorRole: e.actorRole,
      at: e.at.toISOString(),
    })),
    reporter: reporter ? { id: reporter.id as string, displayName: reporter.displayName } : null,
    reporterTrackRecord: record,
    appeal: appeal
      ? { status: appeal.status, note: appeal.note, decisionNote: appeal.decisionNote, createdAt: appeal.createdAt.toISOString(), decidedAt: appeal.decidedAt?.toISOString() ?? null }
      : null,
    appealUntil: appealUntil && appealUntil.getTime() > Date.now() ? appealUntil.toISOString() : null,
  };
}

export async function toListItems(subs: SubmissionDoc[]): Promise<SubmissionListItem[]> {
  const locations = await LocationModel.find({ _id: { $in: subs.map((s) => s.locationId).filter(Boolean) } });
  const summaries = new Map(await Promise.all(locations.map(async (l) => [l.id as string, await toSummary(l)] as const)));
  return subs.map((s) => ({
    id: s.id as string,
    status: s.status,
    headline: s.headline,
    language: s.language,
    location: s.locationId ? (summaries.get(String(s.locationId)) ?? null) : null,
    riskLevel: s.riskLevel,
    aiStatus: s.aiStatus,
    origin: s.origin,
    submittedAt: s.submittedAt?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
    possibleDuplicateCount: s.possibleDuplicateIds.length,
  }));
}

// ---------- transitions ----------
export async function record(event: Omit<EditorialEvent, 'at'>): Promise<void> {
  await EditorialEventModel.create({ ...event, at: new Date() });
}

/**
 * The only way a submission changes status: an atomic compare-and-set on the current status, plus an event in the
 * history. If two people act at once, one wins and the other gets 409.
 */
export async function transition(
  sub: SubmissionDoc,
  from: SubmissionStatus[],
  to: SubmissionStatus,
  set: Partial<Submission>,
  event: { actorId: Types.ObjectId | null; actorRole: EditorialEvent['actorRole']; action: string; reasonCode?: string | null; note?: string | null; visibleToReporter?: boolean },
): Promise<SubmissionDoc> {
  if (!from.includes(sub.status)) throw Errors.conflict(`Not possible while the submission is ${sub.status.replace('_', ' ')}`);
  const updated = await SubmissionModel.findOneAndUpdate({ _id: sub._id, status: { $in: from } }, { $set: { ...set, status: to } }, { new: true });
  if (!updated) throw Errors.conflict('This submission was changed by someone else. Reload and try again.');
  await record({
    submissionId: sub._id,
    actorId: event.actorId,
    actorRole: event.actorRole,
    action: event.action,
    fromStatus: sub.status,
    toStatus: to,
    reasonCode: event.reasonCode ?? null,
    note: event.note ?? null,
    visibleToReporter: event.visibleToReporter ?? true,
  });
  return updated;
}

// ---------- reporter actions ----------
async function resolveLocation(locationId: string | null | undefined) {
  if (!locationId) return { locationId: null, locationLineage: [], districtId: null };
  const loc = await LocationModel.findById(locationId);
  if (!loc) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown location', [{ path: 'locationId', message: 'Unknown location' }]);
  const chain = await LocationModel.find({ _id: { $in: [loc._id, ...loc.ancestorIds] } }, { level: 1 });
  const district = chain.find((l) => l.level === 'district');
  return { locationId: loc._id, locationLineage: [loc._id, ...loc.ancestorIds], districtId: district?._id ?? null };
}

function draftFields(input: SaveDraftRequest) {
  const out: Partial<Submission> = {};
  if (input.headline !== undefined) out.headline = input.headline;
  if (input.summary !== undefined) out.summary = input.summary;
  if (input.body !== undefined) out.body = input.body;
  if (input.language !== undefined) out.language = input.language;
  if (input.incidentDate !== undefined) out.incidentDate = input.incidentDate ? new Date(`${input.incidentDate}T00:00:00Z`) : null;
  if (input.supportingUrls !== undefined) out.supportingUrls = input.supportingUrls;
  if (input.editorContext !== undefined) out.editorContext = input.editorContext;
  return out;
}

export async function createDraft(user: UserDoc, input: SaveDraftRequest): Promise<SubmissionDoc> {
  const loc = await resolveLocation(input.locationId);
  if (input.categoryId && !(await CategoryModel.exists({ _id: input.categoryId }))) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category');
  const sub = await SubmissionModel.create({
    reporterId: user._id,
    status: 'draft',
    ...draftFields(input),
    ...loc,
    categoryId: input.categoryId ?? null,
  });
  await record({ submissionId: sub._id, actorId: user._id, actorRole: 'reporter', action: 'created', fromStatus: null, toStatus: 'draft', reasonCode: null, note: null, visibleToReporter: true });
  return sub;
}

export async function updateDraft(user: UserDoc, id: string, input: SaveDraftRequest): Promise<SubmissionDoc> {
  const sub = await getOwnSubmission(user, id);
  if (!EDITABLE.includes(sub.status)) throw Errors.conflict('This submission can no longer be edited');
  const set: Partial<Submission> = draftFields(input);
  if (input.locationId !== undefined) Object.assign(set, await resolveLocation(input.locationId));
  if (input.categoryId !== undefined) {
    if (input.categoryId && !(await CategoryModel.exists({ _id: input.categoryId }))) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category');
    set.categoryId = input.categoryId ? new Types.ObjectId(input.categoryId) : null;
  }
  const updated = await SubmissionModel.findOneAndUpdate({ _id: sub._id, status: { $in: EDITABLE } }, { $set: set }, { new: true });
  if (!updated) throw Errors.conflict('This submission can no longer be edited');
  return updated;
}

/** What a submission must contain before an editor sees it. */
const ReadyToSubmit = z.object({
  headline: z.string().min(5, 'Add a headline (at least 5 characters)'),
  summary: z.string().min(10, 'Add a short summary (at least 10 characters)'),
  body: z.string().min(20, 'Describe what happened (at least 20 characters)'),
  locationId: z.custom<Types.ObjectId>((v) => v != null, 'Choose the place'),
  categoryId: z.custom<Types.ObjectId>((v) => v != null, 'Choose a topic'),
  incidentDate: z.custom<Date | null>((v) => v == null || (v as Date).getTime() <= Date.now() + 86_400_000, 'The date cannot be in the future'),
});

export async function submit(user: UserDoc, id: string, responseNote: string | undefined): Promise<SubmissionDoc> {
  const sub = await getOwnSubmission(user, id);
  const check = ReadyToSubmit.safeParse(sub.toObject());
  if (!check.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'The submission is not complete', check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const category = await CategoryModel.findById(sub.categoryId, { slug: 1 });
  const risk = screenRisk(`${sub.headline} ${sub.summary} ${sub.body}`, category?.slug ?? null);
  // An editor's manual risk decision is never lowered by the automatic screen.
  const riskLevel: RiskLevel = sub.riskSetByEditor && sub.riskLevel === 'high' ? 'high' : risk.level === 'high' || sub.riskLevel === 'high' ? 'high' : 'normal';
  const version = sub.version + 1;
  const submittedAt = sub.submittedAt ?? new Date();
  const queueAt = sub.origin === 'citizen' ? queuePosition(submittedAt, await trackRecord(sub.reporterId)) : submittedAt;
  await SubmissionVersionModel.create({
    submissionId: sub._id,
    version,
    headline: sub.headline,
    summary: sub.summary,
    body: sub.body,
    supportingUrls: sub.supportingUrls,
    editorContext: sub.editorContext,
    responseNote: responseNote ?? null,
  });
  let updated = await transition(
    sub,
    EDITABLE,
    'submitted',
    {
      version,
      riskLevel,
      riskRank: riskLevel === 'high' ? 1 : 0,
      riskReasons: [...new Set([...sub.riskReasons, ...risk.reasons])],
      submittedAt,
      queueAt,
      assignedEditorId: null,
    },
    { actorId: user._id, actorRole: 'reporter', action: sub.status === 'draft' ? 'submitted' : 'resubmitted', note: responseNote ?? null },
  );
  const duplicates = await findDuplicates(updated);
  if (duplicates.length) {
    updated = (await SubmissionModel.findByIdAndUpdate(updated._id, { $addToSet: { possibleDuplicateIds: { $each: duplicates } } }, { new: true }))!;
    await SubmissionModel.updateMany({ _id: { $in: duplicates } }, { $addToSet: { possibleDuplicateIds: updated._id } });
  }
  await onSubmitted(updated);
  // The hook may have changed fields (e.g. aiStatus), so return the stored document.
  return (await SubmissionModel.findById(updated._id)) ?? updated;
}

export async function withdraw(user: UserDoc, id: string): Promise<SubmissionDoc> {
  const sub = await getOwnSubmission(user, id);
  return transition(sub, ['draft', 'submitted', 'needs_info', 'returned'], 'withdrawn', {}, { actorId: user._id, actorRole: 'reporter', action: 'withdrawn' });
}

export async function listOwn(user: UserDoc): Promise<SubmissionDoc[]> {
  return SubmissionModel.find({ reporterId: user._id }).sort({ updatedAt: -1 }).limit(100);
}

// ---------- editor actions ----------
interface QueueCursor {
  r: number;
  t: string;
  id: string;
}
export async function editorQueue(user: UserDoc, status: SubmissionStatus, limit: number, rawCursor?: string) {
  let after: FilterQuery<Submission> = {};
  if (rawCursor) {
    let c: QueueCursor;
    try {
      c = JSON.parse(Buffer.from(rawCursor, 'base64url').toString()) as QueueCursor;
      if (!Types.ObjectId.isValid(c.id)) throw new Error();
    } catch {
      throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor');
    }
    const t = new Date(c.t);
    const id = new Types.ObjectId(c.id);
    // Sort order: high risk first, then oldest first (first come, first reviewed; trusted reporters get a head start).
    after = { $or: [{ riskRank: { $lt: c.r } }, { riskRank: c.r, queueAt: { $gt: t } }, { riskRank: c.r, queueAt: t, _id: { $gt: id } }] };
  }
  const docs = await SubmissionModel.find({ $and: [{ status }, scopeFilter(user), after] })
    .sort({ riskRank: -1, queueAt: 1, _id: 1 })
    .limit(limit + 1);
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    docs.length > limit && last
      ? Buffer.from(JSON.stringify({ r: last.riskRank, t: (last.queueAt ?? last.submittedAt ?? last.createdAt).toISOString(), id: last.id } satisfies QueueCursor)).toString('base64url')
      : null;
  return { items: await toListItems(page), nextCursor };
}

export async function claim(editor: UserDoc, id: string) {
  const sub = await getSubmissionForEditor(editor, id);
  return transition(sub, ['submitted'], 'in_review', { assignedEditorId: editor._id }, { actorId: editor._id, actorRole: 'editor', action: 'review_started' });
}

export async function requestInfo(editor: UserDoc, id: string, note: string) {
  const sub = await getSubmissionForEditor(editor, id);
  return transition(sub, ['in_review'], 'needs_info', {}, { actorId: editor._id, actorRole: 'editor', action: 'info_requested', note });
}

export async function returnForRevision(editor: UserDoc, id: string, note: string) {
  const sub = await getSubmissionForEditor(editor, id);
  return transition(sub, ['in_review'], 'returned', {}, { actorId: editor._id, actorRole: 'editor', action: 'returned', note });
}

export async function reject(editor: UserDoc, id: string, reasonCode: RejectionReason, note: string) {
  const sub = await getSubmissionForEditor(editor, id);
  return transition(sub, ['in_review'], 'rejected', {}, { actorId: editor._id, actorRole: 'editor', action: 'rejected', reasonCode, note });
}

export async function setRisk(editor: UserDoc, id: string, riskLevel: RiskLevel, note: string) {
  const sub = await getSubmissionForEditor(editor, id);
  if (['published', 'rejected', 'withdrawn'].includes(sub.status)) throw Errors.conflict('This submission is closed');
  if (sub.riskLevel === 'high' && riskLevel === 'normal' && !isSeniorEditor(editor)) {
    throw Errors.forbidden('Only a senior editor can lower the risk level');
  }
  const updated = await SubmissionModel.findByIdAndUpdate(
    sub._id,
    { $set: { riskLevel, riskRank: riskLevel === 'high' ? 1 : 0, riskSetByEditor: true } },
    { new: true },
  );
  await record({ submissionId: sub._id, actorId: editor._id, actorRole: 'editor', action: `risk_set_${riskLevel}`, fromStatus: null, toStatus: null, reasonCode: null, note, visibleToReporter: false });
  return updated!;
}

export async function publishSubmission(editor: UserDoc, id: string, input: PublishSubmissionRequest) {
  const sub = await getSubmissionForEditor(editor, id);
  if (sub.status !== 'in_review') throw Errors.conflict('Start the review before publishing');
  if (sub.riskLevel === 'high' && !isSeniorEditor(editor)) {
    throw Errors.forbidden('High-risk submissions must be published by a senior editor');
  }
  // Lock first, so two editors cannot create two articles from one submission.
  const now = new Date();
  const locked = await SubmissionModel.findOneAndUpdate(
    { _id: sub._id, status: 'in_review', $or: [{ publishLockAt: null }, { publishLockAt: { $lt: new Date(now.getTime() - PUBLISH_LOCK_MS) } }] },
    { $set: { publishLockAt: now } },
    { new: true },
  );
  if (!locked) throw Errors.conflict('Someone else is publishing this submission');
  try {
    const article = await createArticle(
      {
        headline: input.headline ?? locked.headline,
        summary: input.summary ?? locked.summary,
        body: input.body ?? locked.body,
        language: locked.language,
        locationId: String(locked.locationId),
        categoryId: String(locked.categoryId),
        trustLabel: locked.origin === 'publisher' ? 'official_unverified' : input.trustLabel,
        sourceType: locked.origin === 'publisher' ? 'official_publisher' : 'citizen',
        ...(locked.originalSourceUrl ? { originalSourceUrl: locked.originalSourceUrl } : {}),
      },
      editor._id,
      { submissionId: locked._id, deadline: input.deadline ? new Date(`${input.deadline}T00:00:00Z`) : locked.deadline },
    );
    const published = await transition(
      locked,
      ['in_review'],
      'published',
      { articleId: article._id, publishLockAt: null },
      { actorId: editor._id, actorRole: 'editor', action: 'published', note: input.note ?? null },
    );
    return { submission: published, article };
  } catch (err) {
    await SubmissionModel.updateOne({ _id: sub._id }, { $set: { publishLockAt: null } });
    throw err;
  }
}
