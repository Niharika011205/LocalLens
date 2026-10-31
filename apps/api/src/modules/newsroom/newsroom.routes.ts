import { Router, type Request } from 'express';
import type { SubmissionDoc } from './submission.model';
import {
  EditorNoteRequest,
  ObjectIdString,
  PublishSubmissionRequest,
  QueueQuery,
  RejectSubmissionRequest,
  SaveDraftRequest,
  SetRiskRequest,
  SubmitRequest,
  type SubmissionListResponse,
  type SubmissionResponse,
} from '@locallens/contracts';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import {
  claim,
  createDraft,
  editorQueue,
  getOwnSubmission,
  getSubmissionForEditor,
  listOwn,
  publishSubmission,
  reject,
  requestInfo,
  returnForRevision,
  setRisk,
  submit,
  toListItems,
  toSubmissionDto,
  updateDraft,
  withdraw,
} from './newsroom.service';

/**
 * Reporters: drafts, submission and tracking. Every route is limited to the caller's own submissions. Publishers use
 * the same routes to follow announcements that were routed to review.
 */
export function reporterRouter(): Router {
  const r = Router();
  r.use(requireRole('reporter', 'publisher'));

  r.get('/', async (req, res) => {
    const subs = await listOwn(currentUser(req));
    res.json({ items: await toListItems(subs), nextCursor: null } satisfies SubmissionListResponse);
  });

  r.post('/', async (req, res) => {
    const sub = await createDraft(currentUser(req), SaveDraftRequest.parse(req.body));
    res.status(201).json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  r.get('/:id', async (req, res) => {
    const sub = await getOwnSubmission(currentUser(req), ObjectIdString.parse(req.params.id));
    res.json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  r.patch('/:id', async (req, res) => {
    const sub = await updateDraft(currentUser(req), ObjectIdString.parse(req.params.id), SaveDraftRequest.parse(req.body));
    res.json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  r.post('/:id/submit', async (req, res) => {
    const { responseNote } = SubmitRequest.parse(req.body ?? {});
    const user = currentUser(req);
    const sub = await submit(user, ObjectIdString.parse(req.params.id), responseNote);
    await audit(req, { action: 'submission.submitted', actorId: user._id, targetType: 'submission', targetId: sub.id, metadata: { version: sub.version, riskLevel: sub.riskLevel } });
    res.json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  r.post('/:id/withdraw', async (req, res) => {
    const user = currentUser(req);
    const sub = await withdraw(user, ObjectIdString.parse(req.params.id));
    await audit(req, { action: 'submission.withdrawn', actorId: user._id, targetType: 'submission', targetId: sub.id });
    res.json({ submission: await toSubmissionDto(sub, 'reporter') } satisfies SubmissionResponse);
  });

  return r;
}

/** Editors: the review queue and editorial decisions. Mounted under /editorial (already editor-only). */
export function editorialQueueRouter(): Router {
  const r = Router();
  r.use(requireRole('editor', 'senior_editor', 'admin'));

  r.get('/submissions', async (req, res) => {
    const q = QueueQuery.parse(req.query);
    res.json((await editorQueue(currentUser(req), q.status, q.limit, q.cursor)) satisfies SubmissionListResponse);
  });

  r.get('/submissions/:id', async (req, res) => {
    const sub = await getSubmissionForEditor(currentUser(req), ObjectIdString.parse(req.params.id));
    res.json({ submission: await toSubmissionDto(sub, 'editor') } satisfies SubmissionResponse);
  });

  const act = (name: string, fn: (req: Request) => Promise<SubmissionDoc>) =>
    r.post(`/submissions/:id/${name}`, async (req, res) => {
      const editor = currentUser(req);
      const result = await fn(req);
      const id = String(result._id);
      await audit(req, { action: `submission.${name.replace('-', '_')}`, actorId: editor._id, targetType: 'submission', targetId: id });
      const sub = await getSubmissionForEditor(editor, id);
      res.json({ submission: await toSubmissionDto(sub, 'editor') } satisfies SubmissionResponse);
    });

  act('claim', (req) => claim(currentUser(req), ObjectIdString.parse(req.params.id)));
  act('request-info', (req) => requestInfo(currentUser(req), ObjectIdString.parse(req.params.id), EditorNoteRequest.parse(req.body).note));
  act('return', (req) => returnForRevision(currentUser(req), ObjectIdString.parse(req.params.id), EditorNoteRequest.parse(req.body).note));
  act('reject', (req) => {
    const { reasonCode, note } = RejectSubmissionRequest.parse(req.body);
    return reject(currentUser(req), ObjectIdString.parse(req.params.id), reasonCode, note);
  });
  act('risk', (req) => {
    const { riskLevel, note } = SetRiskRequest.parse(req.body);
    return setRisk(currentUser(req), ObjectIdString.parse(req.params.id), riskLevel, note);
  });
  act('publish', async (req) => {
    const { submission } = await publishSubmission(currentUser(req), ObjectIdString.parse(req.params.id), PublishSubmissionRequest.parse(req.body));
    return submission;
  });

  return r;
}
