import { Router } from 'express';
import { LoginRequest, MfaVerifyRequest, RegisterRequest, type LoginResponse, type SessionResponse, type UserResponse } from '@locallens/contracts';
import { clearSessionCookie, currentUser, requireAuth, setSessionCookie } from '../../middleware/auth';
import { rateLimit, type RateLimiters } from '../../middleware/rate-limit';
import type { AuthService } from './auth.service';
import { MFA_COOKIE } from './mfa';
import { toPublicUser } from './models';

export function authRouter(deps: { auth: AuthService; limiters: RateLimiters; cookieSecure: boolean }): Router {
  const { auth, limiters, cookieSecure } = deps;
  const r = Router();
  const byIp = (l: keyof RateLimiters) => rateLimit(limiters[l], { failClosed: true });

  r.post('/register', byIp('register'), async (req, res) => {
    const { user, token } = await auth.register(RegisterRequest.parse(req.body), req);
    setSessionCookie(res, token, cookieSecure);
    res.status(201).json({ user: toPublicUser(user) } satisfies UserResponse);
  });

  const challengeCookie = { httpOnly: true, secure: cookieSecure, sameSite: 'lax' as const, path: '/api/v1/auth' };

  r.post('/login', byIp('loginIp'), async (req, res) => {
    const result = await auth.login(LoginRequest.parse(req.body), req);
    if ('mfaChallenge' in result) {
      res.cookie(MFA_COOKIE, result.mfaChallenge, { ...challengeCookie, maxAge: 5 * 60_000 });
      return res.json({ mfaRequired: true } satisfies LoginResponse);
    }
    setSessionCookie(res, result.token, cookieSecure);
    res.json({ user: toPublicUser(result.user) } satisfies LoginResponse);
  });

  // Same per-IP limit as passwords; each challenge also allows only 5 attempts.
  r.post('/mfa', byIp('loginIp'), async (req, res) => {
    const { code } = MfaVerifyRequest.parse(req.body);
    const raw: unknown = req.cookies?.[MFA_COOKIE];
    const { user, token } = await auth.completeMfa(typeof raw === 'string' ? raw : undefined, code, req);
    res.clearCookie(MFA_COOKIE, challengeCookie);
    setSessionCookie(res, token, cookieSecure);
    res.json({ user: toPublicUser(user) } satisfies UserResponse);
  });

  r.post('/logout', async (req, res) => {
    await auth.logout(req.auth?.sessionId, req);
    clearSessionCookie(res, cookieSecure);
    res.status(204).end();
  });

  r.post('/logout-all', requireAuth, async (req, res) => {
    await auth.logoutAll(currentUser(req), req);
    clearSessionCookie(res, cookieSecure);
    res.status(204).end();
  });

  r.get('/session', (req, res) => {
    // No caching: the answer depends on the cookie.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: req.auth ? toPublicUser(req.auth.user) : null } satisfies SessionResponse);
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: toPublicUser(currentUser(req)) } satisfies UserResponse);
  });

  return r;
}
