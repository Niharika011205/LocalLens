import type { ErrorCode } from '@locallens/contracts';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: { path: string; message: string }[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: (message = 'Sign in required') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message: string) => new AppError(409, 'CONFLICT', message),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.', undefined, {
      'Retry-After': String(Math.max(1, retryAfterSeconds)),
    }),
  unavailable: (message = 'Service temporarily unavailable') => new AppError(503, 'SERVICE_UNAVAILABLE', message),
};
