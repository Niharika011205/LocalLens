import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Logger } from 'pino';
import {
  MfaCodeRequest,
  MfaDisableRequest,
  MfaSetupRequest,
  ObjectIdString,
  STAFF_ROLES,
  type MfaSetupResponse,
  type MfaStatusResponse,
  type RecoveryCodesResponse,
  type UserResponse,
} from '@locallens/contracts';
import type { Config } from '../../config';
import { newToken, sha256, verifyPassword } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '../../lib/totp';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { MfaChallengeModel, SessionModel, UserModel, toPublicUser, type UserDoc } from './models';

/**
 * Two-step sign-in with an authenticator app (TOTP).
 *
 * - Setup needs the current password; the secret only becomes active after the first correct code.
 * - Ten one-time recovery codes are shown once, stored only as hashes.
 * - Codes cannot be replayed (the last accepted time step is stored).
 * - Signing in: a correct password gives a 5-minute, 5-attempt challenge (httpOnly cookie), not a session.
 * - Staff (editors, publishers, admins) must have it on to use staff tools when MFA_ENFORCE=true (always in
 *   production). A lost phone: another admin resets it, which also signs the user out everywhere.
 */

export const MFA_COOKIE = 'll_mfa';
const CHALLENGE_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;

export const isStaff = (u: UserDoc) => u.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r));

export function mfaKey(config: Config, logger?: Logger): Buffer {
  if (config.MFA_ENCRYPTION_KEY) return Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64');
  // Production refuses to start without a key (config.ts). Elsewhere, a fixed development key keeps local data usable.
  logger?.warn('MFA_ENCRYPTION_KEY not set: using the development key (never do this in production)');
  return createHash('sha256').update('locallens-development-only-mfa-key').digest();
}

const badCode = () => new AppError(400, 'VALIDATION_FAILED', 'That code is not correct', [{ path: 'code', message: 'That code is not correct' }]);

export class MfaService {
  constructor(private readonly key: Buffer) {}

  /** Checks a 6-digit code (or, if allowed, a recovery code) and records its use. Returns how it was verified. */
  async check(user: UserDoc, code: string, allowRecovery: boolean): Promise<'totp' | 'recovery' | null> {
    if (!user.mfa?.enabled || !user.mfa.secretEnc) return null;
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(decryptSecret(user.mfa.secretEnc, this.key), clean, { lastUsedStep: user.mfa.lastUsedStep });
      if (step === null) return null;
      // Compare-and-set on the step, so two requests with the same code cannot both succeed.
      const ok = await UserModel.updateOne({ _id: user._id, 'mfa.lastUsedStep': { $lt: step } }, { $set: { 'mfa.lastUsedStep': step } });
      return ok.modifiedCount === 1 ? 'totp' : null;
    }
    if (!allowRecovery) return null;
    const hash = hashRecoveryCode(clean);
    const used = await UserModel.updateOne({ _id: user._id, 'mfa.recoveryCodeHashes': hash }, { $pull: { 'mfa.recoveryCodeHashes': hash } });
    return used.modifiedCount === 1 ? 'recovery' : null;
  }

  async startSetup(user: UserDoc, password: string, req: Request): Promise<MfaSetupResponse> {
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Current password is incorrect' }]);
    }
    if (user.mfa?.enabled) throw Errors.conflict('Two-step sign-in is already on');
    const secret = newTotpSecret();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecretEnc': encryptSecret(secret, this.key) } });
    await audit(req, { action: 'auth.mfa_setup_started', actorId: user._id, targetType: 'user', targetId: user.id });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async enable(user: UserDoc, code: string, sessionId: UserDoc['_id'], req: Request): Promise<string[]> {
    if (user.mfa?.enabled) throw Errors.conflict('Two-step sign-in is already on');
    if (!user.mfa?.pendingSecretEnc) throw Errors.conflict('Start the setup first');
    const secret = decryptSecret(user.mfa.pendingSecretEnc, this.key);
    const step = verifyTotp(secret, code);
    if (step === null) throw badCode();
    const codes = newRecoveryCodes();
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          'mfa.enabled': true,
          'mfa.secretEnc': user.mfa.pendingSecretEnc,
          'mfa.pendingSecretEnc': null,
          'mfa.lastUsedStep': step,
          'mfa.recoveryCodeHashes': codes.map(hashRecoveryCode),
          'mfa.enabledAt': new Date(),
        },
      },
    );
    // Other devices signed in with only the password are signed out; this one stays.
    await SessionModel.deleteMany({ userId: user._id, _id: { $ne: sessionId } });
    await audit(req, { action: 'auth.mfa_enabled', actorId: user._id, targetType: 'user', targetId: user.id });
    return codes;
  }

  async regenerateRecoveryCodes(user: UserDoc, code: string, req: Request): Promise<string[]> {
    if ((await this.check(user, code, false)) === null) throw badCode();
    const codes = newRecoveryCodes();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'mfa.recoveryCodeHashes': codes.map(hashRecoveryCode) } });
    await audit(req, { action: 'auth.mfa_recovery_codes_regenerated', actorId: user._id, targetType: 'user', targetId: user.id });
    return codes;
  }

  async disable(user: UserDoc, password: string, code: string, enforced: boolean, req: Request): Promise<void> {
    if (enforced && isStaff(user)) throw Errors.forbidden('Staff accounts must keep two-step sign-in on');
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Current password is incorrect' }]);
    }
    if ((await this.check(user, code, false)) === null) throw badCode();
    await UserModel.updateOne({ _id: user._id }, { $set: { mfa: {} } });
    await audit(req, { action: 'auth.mfa_disabled', actorId: user._id, targetType: 'user', targetId: user.id });
  }

  // ---------- sign-in challenge ----------
  async createChallenge(user: UserDoc): Promise<string> {
    const token = newToken();
    await MfaChallengeModel.create({ tokenHash: sha256(token), userId: user._id, expiresAt: new Date(Date.now() + CHALLENGE_MS) });
    return token;
  }

  /** Returns the user when the code is right. Wrong codes count; after 5 the challenge is gone (sign in again). */
  async completeChallenge(token: string | undefined, code: string, req: Request): Promise<{ user: UserDoc; method: 'totp' | 'recovery' }> {
    const expired = () => Errors.unauthenticated('Your sign-in expired. Enter your email and password again.');
    if (!token) throw expired();
    const challenge = await MfaChallengeModel.findOneAndUpdate(
      { tokenHash: sha256(token), expiresAt: { $gt: new Date() }, attempts: { $lt: CHALLENGE_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (!challenge) throw expired();
    const user = await UserModel.findById(challenge.userId);
    if (!user || user.status !== 'active') throw expired();
    const method = await this.check(user, code, true);
    if (!method) {
      await audit(req, { action: 'auth.mfa_failed', targetType: 'user', targetId: user.id, metadata: { attempt: challenge.attempts } });
      if (challenge.attempts >= CHALLENGE_ATTEMPTS) await MfaChallengeModel.deleteOne({ _id: challenge._id });
      throw badCode();
    }
    await MfaChallengeModel.deleteOne({ _id: challenge._id });
    return { user, method };
  }
}

// ---------- routes ----------
/** Under /me (signed in). Status, setup, enable, recovery codes, disable. */
export function mfaRouter(deps: { mfa: MfaService; enforced: boolean }): Router {
  const { mfa, enforced } = deps;
  const r = Router();
  r.use(requireAuth);

  r.get('/mfa', (req, res) => {
    const u = currentUser(req);
    res.json({ enabled: !!u.mfa?.enabled, requiredForRoles: isStaff(u), enforced, recoveryCodesLeft: u.mfa?.recoveryCodeHashes?.length ?? 0 } satisfies MfaStatusResponse);
  });

  r.post('/mfa/setup', async (req, res) => {
    const { currentPassword } = MfaSetupRequest.parse(req.body);
    res.json((await mfa.startSetup(currentUser(req), currentPassword, req)) satisfies MfaSetupResponse);
  });

  r.post('/mfa/enable', async (req, res) => {
    const { code } = MfaCodeRequest.parse(req.body);
    const codes = await mfa.enable(currentUser(req), code, req.auth!.sessionId, req);
    res.json({ recoveryCodes: codes } satisfies RecoveryCodesResponse);
  });

  r.post('/mfa/recovery-codes', async (req, res) => {
    const { code } = MfaCodeRequest.parse(req.body);
    res.json({ recoveryCodes: await mfa.regenerateRecoveryCodes(currentUser(req), code, req) } satisfies RecoveryCodesResponse);
  });

  r.post('/mfa/disable', async (req, res) => {
    const { currentPassword, code } = MfaDisableRequest.parse(req.body);
    await mfa.disable(currentUser(req), currentPassword, code, enforced, req);
    res.status(204).end();
  });

  return r;
}

/** Under /admin: reset two-step sign-in for someone who lost their phone (never your own). */
export function adminMfaRouter(): Router {
  const r = Router();
  r.use(requireRole('admin'));
  r.post('/users/:id/mfa/reset', async (req, res) => {
    const actor = currentUser(req);
    const target = await UserModel.findById(ObjectIdString.parse(req.params.id));
    if (!target) throw Errors.notFound('User not found');
    if (target._id.equals(actor._id)) throw Errors.conflict('Another admin must reset your two-step sign-in');
    target.set('mfa', {});
    await target.save();
    const { deletedCount } = await SessionModel.deleteMany({ userId: target._id });
    await audit(req, { action: 'admin.mfa_reset', actorId: actor._id, targetType: 'user', targetId: target.id, metadata: { sessionsRevoked: deletedCount } });
    res.json({ user: toPublicUser(target) } satisfies UserResponse);
  });
  return r;
}
