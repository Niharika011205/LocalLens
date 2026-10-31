import { Router } from 'express';
import { ChangePasswordRequest, UpdateProfileRequest, type UserResponse } from '@locallens/contracts';
import { currentUser, requireAuth } from '../../middleware/auth';
import { Errors } from '../../lib/errors';
import { audit } from '../audit/audit';
import type { AuthService } from './auth.service';
import { toPublicUser } from './models';

export function meRouter(auth: AuthService, reporterSelfSignup = false): Router {
  const r = Router();
  r.use(requireAuth);

  r.patch('/', async (req, res) => {
    const changes = UpdateProfileRequest.parse(req.body);
    const user = currentUser(req);
    user.set(changes);
    await user.save();
    await audit(req, {
      action: 'user.profile_updated',
      actorId: user._id,
      targetType: 'user',
      targetId: user.id,
      metadata: { fields: Object.keys(changes) },
    });
    res.json({ user: toPublicUser(user) } satisfies UserResponse);
  });

  r.put('/password', async (req, res) => {
    const input = ChangePasswordRequest.parse(req.body);
    await auth.changePassword(currentUser(req), input, req.auth!.sessionId, req);
    res.json({ user: toPublicUser(currentUser(req)) } satisfies UserResponse);
  });

  /** Ask an admin for reporter access. Allowed when never asked or previously rejected. */
  r.post('/reporter-request', async (req, res) => {
    const user = currentUser(req);
    if (user.roles.includes('reporter')) throw Errors.conflict('You already have reporter access');
    if (user.reporterRequest.status === 'pending') throw Errors.conflict('Your request is already waiting for review');
    const now = new Date();
    if (reporterSelfSignup) {
      user.roles = [...new Set([...user.roles, 'reporter' as const])];
      user.reporterRequest = { status: 'approved', requestedAt: now, decidedAt: now, decidedBy: null, note: 'Self sign-up' };
    } else {
      user.reporterRequest = { status: 'pending', requestedAt: now, decidedAt: null, decidedBy: null, note: null };
    }
    await user.save();
    await audit(req, { action: 'user.reporter_requested', actorId: user._id, targetType: 'user', targetId: user.id });
    res.json({ user: toPublicUser(user) } satisfies UserResponse);
  });

  return r;
}
