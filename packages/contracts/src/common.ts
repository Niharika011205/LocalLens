import { z } from 'zod';

export const LANGUAGES = ['te', 'en'] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;

export const ROLES = ['reader', 'reporter', 'editor', 'senior_editor', 'publisher', 'admin'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Roles that can publish or administer: they must use two-step sign-in (enforced in production). */
export const STAFF_ROLES = ['editor', 'senior_editor', 'publisher', 'admin'] as const satisfies readonly Role[];

export const USER_STATUSES = ['active', 'suspended'] as const;
export const UserStatus = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof UserStatus>;

export const REPORTER_REQUEST_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export const ReporterRequestStatus = z.enum(REPORTER_REQUEST_STATUSES);
export type ReporterRequestStatus = z.infer<typeof ReporterRequestStatus>;

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'ACCOUNT_SUSPENDED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'NOT_FOUND',
  'CONFLICT',
  'EMAIL_TAKEN',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL',
  'SERVICE_UNAVAILABLE',
  'MFA_SETUP_REQUIRED',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ObjectIdString = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const ReporterRequest = z.object({
  status: ReporterRequestStatus,
  requestedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type ReporterRequest = z.infer<typeof ReporterRequest>;

export const PublicUser = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  preferredLanguage: Language,
  roles: z.array(Role),
  status: UserStatus,
  reporterRequest: ReporterRequest,
  /** True after an admin reset: the user should choose a new password. */
  mustChangePassword: z.boolean(),
  publisherOrgId: z.string().nullable(),
  /** Two-step sign-in: whether it is on, and whether this account's roles require it. */
  mfa: z.object({ enabled: z.boolean(), requiredForRoles: z.boolean() }),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const UserResponse = z.object({ user: PublicUser });
export type UserResponse = z.infer<typeof UserResponse>;

/** GET /auth/session: always 200, so the app can ask "who is signed in?" without an error when nobody is. */
export const SessionResponse = z.object({ user: PublicUser.nullable() });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const MessageResponse = z.object({ message: z.string() });
export type MessageResponse = z.infer<typeof MessageResponse>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
