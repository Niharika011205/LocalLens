import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';
import { sha256 } from '../lib/crypto';
import { Errors } from '../lib/errors';

export interface RateLimiters {
  global: RateLimiterAbstract;
  register: RateLimiterAbstract;
  loginIp: RateLimiterAbstract;
  /** Counts failed logins per account; consumed only on failure, cleared on success. */
  loginFailuresByEmail: RateLimiterAbstract;
  /** AI assistant questions per signed-in user (each one can cost a model call). */
  assistant: RateLimiterAbstract;
  /** Quick posts per reporter. */
  posts: RateLimiterAbstract;
}

interface LimitSpec {
  points: number;
  duration: number;
  blockDuration?: number;
}

export const DEFAULT_LIMITS: Record<keyof RateLimiters, LimitSpec> = {
  global: { points: 300, duration: 60 },
  register: { points: 10, duration: 60 * 60 },
  loginIp: { points: 30, duration: 15 * 60 },
  loginFailuresByEmail: { points: 5, duration: 15 * 60, blockDuration: 15 * 60 },
  assistant: { points: 20, duration: 60 * 60 },
  posts: { points: 20, duration: 60 * 60 },
};

export function createRateLimiters(
  store: { kind: 'redis'; client: Redis } | { kind: 'memory' },
  limits: Record<keyof RateLimiters, LimitSpec> = DEFAULT_LIMITS,
): RateLimiters {
  const make = (name: keyof RateLimiters): RateLimiterAbstract => {
    const opts = { keyPrefix: `rl:${name}`, ...limits[name] };
    return store.kind === 'redis'
      ? new RateLimiterRedis({ storeClient: store.client, ...opts })
      : new RateLimiterMemory(opts);
  };
  return {
    global: make('global'),
    register: make('register'),
    loginIp: make('loginIp'),
    loginFailuresByEmail: make('loginFailuresByEmail'),
    assistant: make('assistant'),
    posts: make('posts'),
  };
}

/** Limiter keys never contain raw email addresses (Redis is not a place for personal data). */
export const emailKey = (email: string) => sha256(email.trim().toLowerCase());

/**
 * Consumes one point for the request.
 * failClosed=true: if the store (Redis) is unreachable the request is refused (used for auth endpoints, where
 * losing brute-force protection is worse than a short outage). failClosed=false: the request is allowed through.
 */
export function rateLimit(
  limiter: RateLimiterAbstract,
  opts: { failClosed: boolean; key?: (req: Request) => string },
): RequestHandler {
  const keyOf = opts.key ?? ((req: Request) => req.ip ?? 'unknown');
  return async (req, _res, next) => {
    try {
      await limiter.consume(keyOf(req));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) return next(Errors.rateLimited(Math.ceil(err.msBeforeNext / 1000)));
      req.log.error({ err }, 'rate limiter store unavailable');
      if (opts.failClosed) return next(Errors.unavailable());
      next();
    }
  };
}
