import { z } from 'zod';
import { Language, PublicUser } from './common';

// Email is normalised (trimmed, lowercased) before it is validated so "Ravi@Mail.com " and "ravi@mail.com" are one account.
export const Email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');

// NIST SP 800-63B: length matters, composition rules do not. The upper bound stops very long inputs being used to
// make the server do expensive hashing work.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const Password = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

export const DisplayName = z.string().trim().min(2, 'Name is too short').max(60, 'Name is too long');

export const RegisterRequest = z
  .object({
    email: Email,
    password: Password,
    displayName: DisplayName,
    preferredLanguage: Language.default('te'),
    // Asking is all a user can do: reporter access is granted by an admin. Editor/admin are never self-service.
    requestReporter: z.boolean().default(false),
  })
  .strict();
/** Parsed shape (defaults applied) — what the server works with. */
export type RegisterRequest = z.infer<typeof RegisterRequest>;
/** Shape a client may send. */
export type RegisterRequestBody = z.input<typeof RegisterRequest>;

export const LoginRequest = z
  .object({
    email: Email,
    // Login does not enforce the minimum length: an old account must still be able to sign in if the policy changes.
    password: z.string().min(1).max(PASSWORD_MAX),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChangePasswordRequest = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX),
    newPassword: Password,
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.optional(),
    preferredLanguage: Language.optional(),
  })
  .strict()
  .refine((v) => v.displayName !== undefined || v.preferredLanguage !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

// ---------- two-step sign-in (TOTP authenticator apps) ----------
/** A password sign-in either completes, or (two-step sign-in on) asks for a code next. */
export const LoginResponse = z.union([z.object({ user: PublicUser }), z.object({ mfaRequired: z.literal(true) })]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/** A 6-digit authenticator code, or a recovery code like "k7mq-x2fp". */
const MfaCode = z.string().trim().min(6, 'Enter the 6-digit code').max(20);
export const MfaVerifyRequest = z.object({ code: MfaCode }).strict();
export const MfaCodeRequest = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();
export const MfaSetupRequest = z.object({ currentPassword: z.string().min(1).max(PASSWORD_MAX) }).strict();
export const MfaDisableRequest = z.object({ currentPassword: z.string().min(1).max(PASSWORD_MAX), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();
export const MfaSetupResponse = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type MfaSetupResponse = z.infer<typeof MfaSetupResponse>;
export const RecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;
export const MfaStatusResponse = z.object({ enabled: z.boolean(), requiredForRoles: z.boolean(), enforced: z.boolean(), recoveryCodesLeft: z.number() });
export type MfaStatusResponse = z.infer<typeof MfaStatusResponse>;
