import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence, layer 2 of 3 (layer 1: SameSite=Lax cookies; layer 3: JSON-only bodies).
 * Browsers attach an Origin header to every cross-site request and to same-origin POST/PUT/PATCH/DELETE, so an
 * unsafe request whose Origin is missing or foreign did not come from our web app.
 */
export function originCheck(appOrigin: string): RequestHandler {
  const allowed = new URL(appOrigin).origin;
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin !== allowed) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Request origin not allowed'));
    }
    next();
  };
}

/**
 * Requests that carry a body must be JSON. An HTML form on another site can only send form-encoded or text bodies
 * without a CORS preflight, so this closes the classic form-POST CSRF route even if the Origin check were bypassed.
 */
/** The only routes that accept a file upload (multipart/form-data, parsed by multer on that route). */
const MULTIPART_ROUTES = new Set(['POST /posts', 'POST /posts/']);

export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && req.is('multipart/form-data') && MULTIPART_ROUTES.has(`${req.method} ${req.path}`)) return next();
  if (hasBody && !req.is('application/json')) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must be application/json'));
  }
  next();
};
