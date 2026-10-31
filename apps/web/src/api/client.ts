import { ErrorBody, type ErrorCode } from '@locallens/contracts';

export type ClientErrorCode = ErrorCode | 'NETWORK';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * All API calls go through here. Same-origin only: the session cookie is httpOnly, so JavaScript never sees it,
 * and the browser adds the Origin header that the server's CSRF check expects.
 */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(data);
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiError(res.status, e.code, e.message, e.details);
    }
    throw new ApiError(res.status, res.status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED', `HTTP ${res.status}`);
  }
  return data as T;
}

/** Server validation details → per-field messages, keyed by the top-level field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.details) return {};
  return Object.fromEntries(err.details.map((d) => [d.path.split('.')[0] ?? d.path, d.message]));
}

export function errorCode(err: unknown): ClientErrorCode {
  return err instanceof ApiError ? err.code : 'INTERNAL';
}
