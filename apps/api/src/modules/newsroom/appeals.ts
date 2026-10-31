import { Router } from 'express';
import {
  APPEAL_WINDOW_DAYS,
  AppealDecisionRequest,
  AppealListQuery,
  AppealRequest,
  ObjectIdString,
  type Appeal as AppealDto,
  type AppealListResponse,
  type AppealResponse,
  type RejectionReason,
  type SubmissionResponse,
  type TrackRecordResponse,
} from '@locallens/contracts';
import { Errors } from '../../lib/errors';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { UserModel, type UserDoc } from '../identity/models';
import { editorCanAccess, getOwnSubmission, record, scopeFilter, toSubmissionDto, transition } from './newsroom.service';
import { AppealModel, EditorialEventModel, SubmissionModel, type AppealDoc } from './submission.model';
import { trackRecord } from './track-record';

/**
 * Appeals against rejections.
 * - The reporter may appeal once, within 14 days of the rejection, with a reason.
 * - A senior editor who did NOT make the rejection decides it. Overturned = back in the review queue (not published:
 *   it still needs a normal editorial review). Upheld = stays rejected. Both outcomes and notes go in the timeline.
 */

async function lastRejection(submissionId: AppealDoc['submissionId']) {
  return EditorialEventModel.findOne({ submissionId, action: 'rejected' }).sort({ at: -1 }).lean();
}

async function toAppealDto(a: AppealDoc, forEditor: boolean): Promise<AppealDto> {
  const [sub, rejection, reporter] = await Promise.all([
    SubmissionModel.findById(a.submissionId, { headline: 1 }).lean(),
    lastRejection(a.submissionId),
    forEditor ? UserModel.findById(a.reporterId, { displayName: 1 }).lean() : null,
  ]);
  return {
    id: a.id as string,
    status: a.status,
    note: a.note,
    decisionNote: a.decisionNote,
    createdAt: a.createdAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    submission: {
      id: a.submissionId.toHexString(),
      headline: sub?.headline ?? '',
      reasonCode: (rejection?.reasonCode as RejectionReason | null) ?? null,
      rejectionNote: rejection?.note ?? null,
    },
    reporter: reporter ? { id: reporter._id.toHexString(), displayName: reporter.displayName } : null,
  };
}

/** Reporter side, mounted at /submissions (before the reporter router, so /track-record is not taken as an id). */
export function reporterAppealsRouter(): Router {
  const r = Router();
  r.use(requireRole('reporter', 'publisher'));

  r.get('/track-record', async (req, res) => {
    res.json({ trackRecord: await trackRecord(currentUser(req)._id) } satisfies TrackRecordResponse);
  });

  r.post('/:id/appeal', async (req, res) => {
    const user = currentUser(req);
    const { note } = AppealRequest.parse(req.body);
    const sub = await getOwnSubmission(user, ObjectIdString.parse(req.params.id));
    if (sub.status !== 'rejected' || sub.origin !== 'citizen') throw Errors.conflict('Only rejected reports can be appealed');
    const rejection = await lastRejection(sub._id);
    if (!rejection || Date.now() - rejection.at.getTime() > APPEAL_WINDOW_DAYS * 86_400_000) {
      throw Errors.conflict(`Appeals must be made within ${APPEAL_WINDOW_DAYS} days of the decision`);
    }
    try {
      await AppealModel.create({ submissionId: sub._id, reporterId: user._id, rejectedBy: rejection.actorId, note });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Errors.conflict('This report has already been appealed');
      throw err;
    }
    await record({ submissionId: sub._id, actorId: user._id, actorRole: 'reporter', action: 'appealed', fromStatus: null, toStatus: null, reasonCode: null, note, visibleToReporter: true });
    await audit(req, { action: 'submission.appealed', actorId: user._id, targetType: 'submission', targetId: sub.id });
    res.status(201).json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  return r;
}

/** Senior editor side, mounted at /editorial. */
export function editorialAppealsRouter(): Router {
  const r = Router();
  r.use(requireRole('senior_editor', 'admin'));

  r.get('/appeals', async (req, res) => {
    const { status, limit } = AppealListQuery.parse(req.query);
    const editor = currentUser(req);
    const scoped = editor.editorScopes?.length
      ? { submissionId: { $in: (await SubmissionModel.find(scopeFilter(editor), { _id: 1 }).lean()).map((s) => s._id) } }
      : {};
    const docs = await AppealModel.find({ status, ...scoped }).sort({ createdAt: status === 'open' ? 1 : -1 }).limit(limit);
    res.json({ items: await Promise.all(docs.map((a) => toAppealDto(a, true))) } satisfies AppealListResponse);
  });

  r.post('/appeals/:id/decide', async (req, res) => {
    const editor: UserDoc = currentUser(req);
    const { outcome, note } = AppealDecisionRequest.parse(req.body);
    const appeal = await AppealModel.findById(ObjectIdString.parse(req.params.id));
    const sub = appeal ? await SubmissionModel.findById(appeal.submissionId) : null;
    if (!appeal || !sub || !editorCanAccess(editor, sub)) throw Errors.notFound('Appeal not found');
    if (appeal.rejectedBy?.equals(editor._id)) throw Errors.forbidden('A different senior editor must decide an appeal against your own decision');

    // Compare-and-set: only one decision wins.
    const decided = await AppealModel.findOneAndUpdate(
      { _id: appeal._id, status: 'open' },
      { $set: { status: outcome, decidedBy: editor._id, decisionNote: note, decidedAt: new Date() } },
      { new: true },
    );
    if (!decided) throw Errors.conflict('This appeal has already been decided');

    if (outcome === 'overturned') {
      await transition(sub, ['rejected'], 'submitted', { assignedEditorId: null }, { actorId: editor._id, actorRole: 'editor', action: 'appeal_overturned', note });
    } else {
      await record({ submissionId: sub._id, actorId: editor._id, actorRole: 'editor', action: 'appeal_upheld', fromStatus: null, toStatus: null, reasonCode: null, note, visibleToReporter: true });
    }
    await audit(req, { action: `appeal.${outcome}`, actorId: editor._id, targetType: 'submission', targetId: sub.id, metadata: { appealId: decided.id } });
    res.json({ appeal: await toAppealDto(decided, true) } satisfies AppealResponse);
  });

  return r;
}
