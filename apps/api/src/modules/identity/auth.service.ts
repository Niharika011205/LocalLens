import type { Request } from 'express';
import type { Types } from 'mongoose';
import type { ChangePasswordRequest, LoginRequest, RegisterRequest } from '@locallens/contracts';
import { hashPassword, newToken, sha256, verifyPassword } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { emailKey, type RateLimiters } from '../../middleware/rate-limit';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../middleware/auth';
import { audit } from '../audit/audit';
import type { MfaService } from './mfa';
import { SessionModel, UserModel, type UserDoc } from './models';

const DUPLICATE_KEY = 11000;

const emailTaken = () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');

/**
 * Email + password accounts. There is no email verification: no mail is sent anywhere in the app, so the email is
 * simply the login name. Trust comes from roles, which only admins grant.
 */
export class AuthService {
  // Verified against when the email is unknown, so "no such user" takes about as long as "wrong password".
  private readonly dummyHash: Promise<string>;

  constructor(private readonly deps: { limiters: RateLimiters; mfa: MfaService; reporterSelfSignup: boolean }) {
    this.dummyHash = hashPassword(newToken());
  }

  async register(input: RegisterRequest, req: Request): Promise<{ user: UserDoc; token: string }> {
    // Saying "already registered" reveals that the email has an account. Without email delivery there is no way to
    // avoid that, so the register endpoint is rate-limited per IP instead.
    if (await UserModel.exists({ email: input.email })) throw emailTaken();
    const now = new Date();
    let user: UserDoc;
    try {
      user = await UserModel.create({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
        preferredLanguage: input.preferredLanguage,
        roles: input.requestReporter && this.deps.reporterSelfSignup ? ['reader', 'reporter'] : ['reader'],
        status: 'active',
        reporterRequest: !input.requestReporter
          ? { status: 'none' }
          : this.deps.reporterSelfSignup
            ? { status: 'approved', requestedAt: now, decidedAt: now, note: 'Self sign-up' }
            : { status: 'pending', requestedAt: now },
      });
    } catch (err) {
      // Two simultaneous registrations for the same email: the unique index lets exactly one win.
      if ((err as { code?: number }).code === DUPLICATE_KEY) throw emailTaken();
      throw err;
    }
    await audit(req, {
      action: 'auth.registered',
      actorId: user._id,
      targetType: 'user',
      targetId: user.id,
      metadata: { reporterRequested: input.requestReporter },
    });
    return { user, token: await this.createSession(user, req) };
  }

  /** A correct password either signs in, or — with two-step sign-in on — returns a short-lived challenge instead. */
  async login(input: LoginRequest, req: Request): Promise<{ user: UserDoc; token: string } | { mfaChallenge: string }> {
    const limiter = this.deps.limiters.loginFailuresByEmail;
    const key = emailKey(input.email);

    let failures;
    try {
      failures = await limiter.get(key);
    } catch (err) {
      req.log.error({ err }, 'login limiter unavailable');
      throw Errors.unavailable(); // fail closed: no brute-force protection means no login
    }
    if (failures && failures.consumedPoints >= limiter.points) {
      throw Errors.rateLimited(Math.ceil(failures.msBeforeNext / 1000));
    }

    const user = await UserModel.findOne({ email: input.email });
    const passwordOk = user
      ? await verifyPassword(user.passwordHash, input.password)
      : (await verifyPassword(await this.dummyHash, input.password), false);

    if (!user || !passwordOk) {
      await limiter.consume(key).catch(() => undefined); // rejects once the limit is reached; that is expected
      await audit(req, {
        action: 'auth.login_failed',
        targetType: 'user',
        ...(user ? { targetId: user.id } : {}),
        metadata: { knownEmail: Boolean(user) },
      });
      throw Errors.unauthenticated('Incorrect email or password');
    }

    await limiter.delete(key).catch(() => undefined);
    // Status is revealed only to someone who knows the password.
    if (user.status === 'suspended') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
    if (user.mfa?.enabled) {
      await audit(req, { action: 'auth.mfa_challenge_issued', actorId: user._id, targetType: 'user', targetId: user.id });
      return { mfaChallenge: await this.deps.mfa.createChallenge(user) };
    }
    const token = await this.createSession(user, req);
    await audit(req, { action: 'auth.login_succeeded', actorId: user._id, targetType: 'user', targetId: user.id });
    return { user, token };
  }

  /** Second step of sign-in: the code from the authenticator app (or a recovery code). */
  async completeMfa(challenge: string | undefined, code: string, req: Request): Promise<{ user: UserDoc; token: string }> {
    const { user, method } = await this.deps.mfa.completeChallenge(challenge, code, req);
    const token = await this.createSession(user, req);
    await audit(req, { action: 'auth.login_succeeded', actorId: user._id, targetType: 'user', targetId: user.id, metadata: { mfa: method } });
    return { user: (await UserModel.findById(user._id)) ?? user, token };
  }

  async changePassword(user: UserDoc, input: ChangePasswordRequest, currentSessionId: Types.ObjectId, req: Request): Promise<void> {
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      await audit(req, { action: 'auth.password_change_failed', actorId: user._id, targetType: 'user', targetId: user.id });
      throw new AppError(400, 'VALIDATION_FAILED', 'Current password is incorrect', [
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }
    user.passwordHash = await hashPassword(input.newPassword);
    user.mustChangePassword = false;
    await user.save();
    // Whoever knew the old password on another device must not stay signed in; this device stays signed in.
    await SessionModel.deleteMany({ userId: user._id, _id: { $ne: currentSessionId } });
    await audit(req, { action: 'auth.password_changed', actorId: user._id, targetType: 'user', targetId: user.id });
  }

  async logout(sessionId: Types.ObjectId | undefined, req: Request): Promise<void> {
    if (!sessionId) return;
    await SessionModel.deleteOne({ _id: sessionId });
    await audit(req, { action: 'auth.logout', actorId: req.auth?.user._id ?? null });
  }

  async logoutAll(user: UserDoc, req: Request): Promise<void> {
    const { deletedCount } = await SessionModel.deleteMany({ userId: user._id });
    await audit(req, { action: 'auth.logout_all', actorId: user._id, targetType: 'user', targetId: user.id, metadata: { deletedCount } });
  }

  /** A brand-new session on every sign-in prevents session fixation. Only the token's hash is stored. */
  private async createSession(user: UserDoc, req: Request): Promise<string> {
    const token = newToken();
    const now = Date.now();
    await SessionModel.create({
      tokenHash: sha256(token),
      userId: user._id,
      expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      idleExpiresAt: new Date(now + SESSION_IDLE_MS),
      lastSeenAt: new Date(now),
      ip: req.ip ?? '',
      userAgent: (req.get('user-agent') ?? '').slice(0, 300),
    });
    return token;
  }
}
