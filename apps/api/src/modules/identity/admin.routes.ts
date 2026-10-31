import { Router } from 'express';
import { Types } from 'mongoose';
import {
  DecideReporterRequest,
  ListUsersQuery,
  ObjectIdString,
  SetScopesRequest,
  SuspendUserRequest,
  UpdateRolesRequest,
  type ResetPasswordResponse,
  type UserListResponse,
  type UserResponse,
} from '@locallens/contracts';
import { hashPassword, temporaryPassword } from '../../lib/crypto';
import { currentUser, requireRole } from '../../middleware/auth';
import { AppError, Errors } from '../../lib/errors';
import { audit } from '../audit/audit';
import { toSummaries } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { SessionModel, UserModel, toPublicUser } from './models';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findUser(id: string) {
  const user = await UserModel.findById(ObjectIdString.parse(id));
  if (!user) throw Errors.notFound('User not found');
  return user;
}

export function adminRouter(): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/users', async (req, res) => {
    const { q, reporterRequest, limit, cursor } = ListUsersQuery.parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q) {
      // Prefix match on email or display name (case-insensitive); user input is escaped so it is never a regex.
      const prefix = `^${escapeRegex(q)}`;
      filter.$or = [{ email: { $regex: prefix, $options: 'i' } }, { displayName: { $regex: prefix, $options: 'i' } }];
    }
    if (reporterRequest) filter['reporterRequest.status'] = reporterRequest;
    if (cursor) {
      if (!Types.ObjectId.isValid(cursor)) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor');
      filter._id = { $lt: new Types.ObjectId(cursor) };
    }
    // Keyset pagination on _id: stable while new users register, and fast at any depth.
    const users = await UserModel.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const page = users.slice(0, limit);
    const body: UserListResponse = {
      items: page.map(toPublicUser),
      nextCursor: users.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
    res.json(body);
  });

  r.put('/users/:id/roles', async (req, res) => {
    const { roles } = UpdateRolesRequest.parse(req.body);
    const actor = currentUser(req);
    const target = await findUser(req.params.id);
    // Guard against an admin accidentally locking everyone out.
    if (target._id.equals(actor._id) && !roles.includes('admin')) {
      throw Errors.conflict('You cannot remove your own admin role');
    }
    const before = [...target.roles];
    target.roles = roles;
    // Granting reporter directly also settles a pending request, so it does not linger in the approval list.
    if (roles.includes('reporter') && target.reporterRequest.status === 'pending') {
      target.reporterRequest.status = 'approved';
      target.reporterRequest.decidedAt = new Date();
      target.reporterRequest.decidedBy = actor._id;
    }
    await target.save();
    await audit(req, {
      action: 'admin.roles_changed',
      actorId: actor._id,
      targetType: 'user',
      targetId: target.id,
      metadata: { before, after: roles },
    });
    res.json({ user: toPublicUser(target) } satisfies UserResponse);
  });

  r.post('/users/:id/suspend', async (req, res) => {
    const { reason } = SuspendUserRequest.parse(req.body);
    const actor = currentUser(req);
    const target = await findUser(req.params.id);
    if (target._id.equals(actor._id)) throw Errors.conflict('You cannot suspend yourself');
    target.status = 'suspended';
    await target.save();
    const { deletedCount } = await SessionModel.deleteMany({ userId: target._id });
    await audit(req, {
      action: 'admin.user_suspended',
      actorId: actor._id,
      targetType: 'user',
      targetId: target.id,
      metadata: { reason, sessionsRevoked: deletedCount },
    });
    res.json({ user: toPublicUser(target) } satisfies UserResponse);
  });

  r.post('/users/:id/reactivate', async (req, res) => {
    const actor = currentUser(req);
    const target = await findUser(req.params.id);
    if (target.status !== 'suspended') throw Errors.conflict('User is not suspended');
    target.status = 'active';
    await target.save();
    await audit(req, { action: 'admin.user_reactivated', actorId: actor._id, targetType: 'user', targetId: target.id });
    res.json({ user: toPublicUser(target) } satisfies UserResponse);
  });

  /**
   * No email delivery means no self-service "forgot password". An admin issues a one-time temporary password, passes
   * it to the user through a channel they trust (in person, phone), and the user must choose a new one.
   */
  r.post('/users/:id/reset-password', async (req, res) => {
    const actor = currentUser(req);
    const target = await findUser(req.params.id);
    if (target._id.equals(actor._id)) throw Errors.conflict('Use “Change password” on your account page instead');
    const password = temporaryPassword();
    target.passwordHash = await hashPassword(password);
    target.mustChangePassword = true;
    await target.save();
    const { deletedCount } = await SessionModel.deleteMany({ userId: target._id });
    await audit(req, {
      action: 'admin.password_reset',
      actorId: actor._id,
      targetType: 'user',
      targetId: target.id,
      metadata: { sessionsRevoked: deletedCount },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ temporaryPassword: password } satisfies ResetPasswordResponse);
  });

  r.get('/users/:id/scopes', async (req, res) => {
    const target = await findUser(req.params.id);
    const locations = await LocationModel.find({ _id: { $in: target.editorScopes } });
    res.json({ locations: await toSummaries(locations) });
  });

  /** Limit an editor to the places they cover. Empty list = all places. */
  r.put('/users/:id/scopes', async (req, res) => {
    const { locationIds } = SetScopesRequest.parse(req.body);
    const target = await findUser(req.params.id);
    const locations = await LocationModel.find({ _id: { $in: locationIds } });
    if (locations.length !== new Set(locationIds).size) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown location');
    target.editorScopes = locations.map((l) => l._id);
    await target.save();
    await audit(req, { action: 'admin.scopes_changed', actorId: currentUser(req)._id, targetType: 'user', targetId: target.id, metadata: { locationIds } });
    res.json({ locations: await toSummaries(locations) });
  });

  r.post('/users/:id/reporter-request', async (req, res) => {
    const { decision, note } = DecideReporterRequest.parse(req.body);
    const actor = currentUser(req);
    const target = await findUser(req.params.id);
    if (target.reporterRequest.status !== 'pending') throw Errors.conflict('There is no pending reporter request');
    target.reporterRequest.status = decision === 'approve' ? 'approved' : 'rejected';
    target.reporterRequest.decidedAt = new Date();
    target.reporterRequest.decidedBy = actor._id;
    target.reporterRequest.note = note ?? null;
    if (decision === 'approve' && !target.roles.includes('reporter')) target.roles.push('reporter');
    await target.save();
    await audit(req, {
      action: decision === 'approve' ? 'admin.reporter_approved' : 'admin.reporter_rejected',
      actorId: actor._id,
      targetType: 'user',
      targetId: target.id,
      metadata: { note: note ?? null },
    });
    res.json({ user: toPublicUser(target) } satisfies UserResponse);
  });

  return r;
}
