import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { STAFF_ROLES, type Role } from '@locallens/contracts';
import type { UserDoc } from '../modules/identity/models';
import { SessionModel, UserModel } from '../modules/identity/models';
import { sha256 } from '../lib/crypto';
import { AppError, Errors } from '../lib/errors';

export const SESSION_COOKIE = 'll_session';
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_ABSOLUTE_MS };
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(secure));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  const { maxAge: _maxAge, ...opts } = sessionCookieOptions(secure);
  res.clearCookie(SESSION_COOKIE, opts);
}

/**
 * Resolves the session cookie to a user. Never rejects the request by itself: anonymous access is valid for public
 * routes. Suspended or unverified users are treated as anonymous, so suspension takes effect on the next request.
 */
export const loadSession: RequestHandler = async (req, _res, next) => {
  const raw: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof raw !== 'string' || !TOKEN_SHAPE.test(raw)) return next();

  const now = new Date();
  const session = await SessionModel.findOne({
    tokenHash: sha256(raw),
    expiresAt: { $gt: now },
    idleExpiresAt: { $gt: now },
  });
  if (!session) return next();

  const user = await UserModel.findById(session.userId);
  if (!user || user.status !== 'active') return next();

  req.auth = { user, sessionId: session._id };

  // Sliding idle timeout, written at most every few minutes to avoid a database write on every request.
  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await SessionModel.updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS) } },
    );
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(Errors.unauthenticated());
  next();
};

let mfaEnforced = false;
/** Set once at startup from MFA_ENFORCE. */
export function setMfaEnforcement(on: boolean): void {
  mfaEnforced = on;
}

/**
 * Role check. When two-step sign-in is enforced, a user who reaches this route only through a staff role (editor,
 * publisher, admin…) must have it turned on; they can still read and use their account page to set it up.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(Errors.unauthenticated());
    const matched = req.auth.user.roles.filter((r) => roles.includes(r));
    if (!matched.length) return next(Errors.forbidden());
    const onlyAsStaff = matched.every((r) => (STAFF_ROLES as readonly string[]).includes(r));
    if (mfaEnforced && onlyAsStaff && !req.auth.user.mfa?.enabled) {
      return next(new AppError(403, 'MFA_SETUP_REQUIRED', 'Turn on two-step sign-in in your account to use this'));
    }
    next();
  };
}

/** For handlers placed after requireAuth: returns the signed-in user with a non-optional type. */
export function currentUser(req: Request): UserDoc {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth.user;
}
