import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorBody } from '@locallens/contracts';
import { AppError, Errors } from '../lib/errors';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(Errors.notFound('Route not found'));
};

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_FAILED',
      'Some fields are invalid',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  // Errors raised by express.json() carry a `type`.
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'VALIDATION_FAILED', 'Malformed JSON body');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  const requestId = String(req.id ?? '');
  if (!appError) {
    req.log.error({ err }, 'unhandled error');
  } else if (appError.status >= 500) {
    req.log.error({ err }, appError.message);
  }
  const e = appError ?? new AppError(500, 'INTERNAL', 'Something went wrong');
  if (e.headers) res.set(e.headers);
  const body: ErrorBody = {
    error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId },
  };
  res.status(e.status).json(body);
};
