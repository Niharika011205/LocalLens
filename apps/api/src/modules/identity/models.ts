import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  LANGUAGES,
  REPORTER_REQUEST_STATUSES,
  ROLES,
  STAFF_ROLES,
  USER_STATUSES,
  type Language,
  type PublicUser,
  type ReporterRequestStatus,
  type Role,
  type UserStatus,
} from '@locallens/contracts';

// ---------- users ----------
export interface ReporterRequestState {
  status: ReporterRequestStatus;
  requestedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: Types.ObjectId | null;
  note: string | null;
}

export interface User {
  email: string;
  /** Argon2id PHC string (includes parameters and salt). */
  passwordHash: string;
  /** Set after an admin password reset; cleared when the user chooses a new password. */
  mustChangePassword: boolean;
  displayName: string;
  preferredLanguage: Language;
  roles: Role[];
  status: UserStatus;
  reporterRequest: ReporterRequestState;
  /** Locations an editor is responsible for. Empty = all (pilot default). */
  editorScopes: Types.ObjectId[];
  /** The verified organisation a publisher account belongs to. */
  publisherOrgId: Types.ObjectId | null;
  /** Two-step sign-in. Secrets are AES-GCM encrypted; recovery codes are stored only as hashes. */
  mfa: MfaState;
  createdAt: Date;
  updatedAt: Date;
}
export type UserDoc = HydratedDocument<User>;

export interface MfaState {
  enabled: boolean;
  secretEnc: string | null;
  /** Set during setup until the first code confirms the authenticator app works. */
  pendingSecretEnc: string | null;
  /** Last accepted time step: a code is never accepted twice. */
  lastUsedStep: number;
  recoveryCodeHashes: string[];
  enabledAt: Date | null;
}
const mfaSchema = new Schema<MfaState>(
  {
    enabled: { type: Boolean, default: false },
    secretEnc: { type: String, default: null },
    pendingSecretEnc: { type: String, default: null },
    lastUsedStep: { type: Number, default: -1 },
    recoveryCodeHashes: { type: [String], default: [] },
    enabledAt: { type: Date, default: null },
  },
  { _id: false },
);

const reporterRequestSchema = new Schema<ReporterRequestState>(
  {
    status: { type: String, enum: REPORTER_REQUEST_STATUSES, default: 'none' },
    requestedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: null },
  },
  { _id: false },
);

const userSchema = new Schema<User>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },
    displayName: { type: String, required: true, trim: true },
    preferredLanguage: { type: String, enum: LANGUAGES, default: 'te' },
    roles: { type: [{ type: String, enum: ROLES }], default: [] },
    status: { type: String, enum: USER_STATUSES, default: 'active', required: true },
    reporterRequest: { type: reporterRequestSchema, default: () => ({}) },
    editorScopes: { type: [Schema.Types.ObjectId], default: [] },
    publisherOrgId: { type: Schema.Types.ObjectId, default: null },
    mfa: { type: mfaSchema, default: () => ({}) },
  },
  { timestamps: true },
);
userSchema.index({ roles: 1 });
userSchema.index({ publisherOrgId: 1 });
userSchema.index({ 'reporterRequest.status': 1, 'reporterRequest.requestedAt': 1 });

export const UserModel = model<User>('User', userSchema, 'users');

export function toPublicUser(u: UserDoc): PublicUser {
  const rr = u.reporterRequest;
  return {
    id: u._id.toHexString(),
    email: u.email,
    displayName: u.displayName,
    preferredLanguage: u.preferredLanguage,
    roles: [...u.roles],
    status: u.status,
    reporterRequest: {
      status: rr?.status ?? 'none',
      requestedAt: rr?.requestedAt?.toISOString() ?? null,
      decidedAt: rr?.decidedAt?.toISOString() ?? null,
      note: rr?.note ?? null,
    },
    mustChangePassword: u.mustChangePassword ?? false,
    publisherOrgId: u.publisherOrgId ? String(u.publisherOrgId) : null,
    mfa: { enabled: !!u.mfa?.enabled, requiredForRoles: u.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r)) },
    createdAt: u.createdAt.toISOString(),
  };
}

// ---------- sessions ----------
export interface Session {
  tokenHash: string;
  userId: Types.ObjectId;
  expiresAt: Date;
  idleExpiresAt: Date;
  lastSeenAt: Date;
  ip: string;
  userAgent: string;
  createdAt: Date;
}

const sessionSchema = new Schema<Session>(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    // TTL index: MongoDB deletes the document once expiresAt passes (checked about once a minute).
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    idleExpiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const SessionModel = model<Session>('Session', sessionSchema, 'sessions');

/** Between a correct password and a correct code (two-step sign-in). Short-lived; a few attempts only. */
export interface MfaChallenge {
  tokenHash: string;
  userId: Types.ObjectId;
  attempts: number;
  expiresAt: Date;
}
const mfaChallengeSchema = new Schema<MfaChallenge>({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
mfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const MfaChallengeModel = model<MfaChallenge>('MfaChallenge', mfaChallengeSchema, 'mfa_challenges');
