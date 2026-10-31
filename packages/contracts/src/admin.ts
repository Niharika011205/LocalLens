import { z } from 'zod';
import { Paginated, PublicUser, Role } from './common';

export const UpdateRolesRequest = z
  .object({
    roles: z
      .array(Role)
      .max(6)
      .refine((r) => new Set(r).size === r.length, 'Roles must not repeat'),
  })
  .strict();
export type UpdateRolesRequest = z.infer<typeof UpdateRolesRequest>;

export const SuspendUserRequest = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type SuspendUserRequest = z.infer<typeof SuspendUserRequest>;

export const DecideReporterRequest = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type DecideReporterRequest = z.infer<typeof DecideReporterRequest>;

/** Returned once to the admin, who passes it to the user through a trusted channel. */
export const ResetPasswordResponse = z.object({ temporaryPassword: z.string() });
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponse>;

export const ListUsersQuery = z.object({
  // Matches the start of an email address or of a display name.
  q: z.string().trim().max(254).optional(),
  reporterRequest: z.enum(['pending']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const UserListResponse = Paginated(PublicUser);
export type UserListResponse = z.infer<typeof UserListResponse>;
