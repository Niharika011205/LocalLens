import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  AI_STATUSES,
  LANGUAGES,
  RISK_LEVELS,
  SUBMISSION_STATUSES,
  type AiStatus,
  type Language,
  type RiskLevel,
  type SubmissionStatus,
} from '@locallens/contracts';

/** The reporter's working object. Separate from `articles`, so a public query can never select a draft. */
export interface Submission {
  reporterId: Types.ObjectId;
  origin: 'citizen' | 'publisher';
  status: SubmissionStatus;
  version: number;
  headline: string;
  summary: string;
  body: string;
  language: Language;
  locationId: Types.ObjectId | null;
  locationLineage: Types.ObjectId[];
  districtId: Types.ObjectId | null;
  categoryId: Types.ObjectId | null;
  incidentDate: Date | null;
  supportingUrls: string[];
  editorContext: string;
  /** Publisher-routed announcements keep their official source and deadline for publication. */
  originalSourceUrl: string | null;
  deadline: Date | null;
  riskLevel: RiskLevel;
  /** 1 for high risk: lets the queue sort high-risk first with a plain index. */
  riskRank: number;
  riskReasons: string[];
  /** Set by an editor; a later automatic screen never lowers it. */
  riskSetByEditor: boolean;
  aiStatus: AiStatus;
  possibleDuplicateIds: Types.ObjectId[];
  assignedEditorId: Types.ObjectId | null;
  articleId: Types.ObjectId | null;
  /** Short-lived lock while publishing, so two editors cannot publish the same submission twice. */
  publishLockAt: Date | null;
  submittedAt: Date | null;
  /** Sort key in the review queue: submittedAt minus any track-record head start. */
  queueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type SubmissionDoc = HydratedDocument<Submission>;

const submissionSchema = new Schema<Submission>(
  {
    reporterId: { type: Schema.Types.ObjectId, required: true },
    origin: { type: String, enum: ['citizen', 'publisher'], default: 'citizen' },
    status: { type: String, enum: SUBMISSION_STATUSES, required: true },
    version: { type: Number, default: 0 },
    headline: { type: String, default: '' },
    summary: { type: String, default: '' },
    body: { type: String, default: '' },
    language: { type: String, enum: LANGUAGES, default: 'te' },
    locationId: { type: Schema.Types.ObjectId, default: null },
    locationLineage: { type: [Schema.Types.ObjectId], default: [] },
    districtId: { type: Schema.Types.ObjectId, default: null },
    categoryId: { type: Schema.Types.ObjectId, default: null },
    incidentDate: { type: Date, default: null },
    supportingUrls: { type: [String], default: [] },
    editorContext: { type: String, default: '' },
    originalSourceUrl: { type: String, default: null },
    deadline: { type: Date, default: null },
    riskLevel: { type: String, enum: RISK_LEVELS, default: 'normal' },
    riskRank: { type: Number, default: 0 },
    riskReasons: { type: [String], default: [] },
    riskSetByEditor: { type: Boolean, default: false },
    aiStatus: { type: String, enum: AI_STATUSES, default: 'not_requested' },
    possibleDuplicateIds: { type: [Schema.Types.ObjectId], default: [] },
    assignedEditorId: { type: Schema.Types.ObjectId, default: null },
    articleId: { type: Schema.Types.ObjectId, default: null },
    publishLockAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    queueAt: { type: Date, default: null },
  },
  { timestamps: true },
);
submissionSchema.index({ reporterId: 1, updatedAt: -1 });
submissionSchema.index({ status: 1, riskRank: -1, queueAt: 1, _id: 1 });
submissionSchema.index({ districtId: 1, submittedAt: -1 });
submissionSchema.index({ locationLineage: 1, status: 1 });

export const SubmissionModel = model<Submission>('Submission', submissionSchema, 'submissions');

/** Immutable snapshot of what the reporter sent each time they submitted. */
export interface SubmissionVersion {
  submissionId: Types.ObjectId;
  version: number;
  headline: string;
  summary: string;
  body: string;
  supportingUrls: string[];
  editorContext: string;
  responseNote: string | null;
  createdAt: Date;
}
const versionSchema = new Schema<SubmissionVersion>(
  {
    submissionId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    headline: String,
    summary: String,
    body: String,
    supportingUrls: [String],
    editorContext: String,
    responseNote: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
versionSchema.index({ submissionId: 1, version: 1 }, { unique: true });
export const SubmissionVersionModel = model<SubmissionVersion>('SubmissionVersion', versionSchema, 'submission_versions');

/** Append-only history of every status change and editorial message. */
export interface EditorialEvent {
  submissionId: Types.ObjectId;
  actorId: Types.ObjectId | null;
  actorRole: 'reporter' | 'editor' | 'system';
  action: string;
  fromStatus: SubmissionStatus | null;
  toStatus: SubmissionStatus | null;
  reasonCode: string | null;
  note: string | null;
  visibleToReporter: boolean;
  at: Date;
}
const eventSchema = new Schema<EditorialEvent>(
  {
    submissionId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorRole: { type: String, enum: ['reporter', 'editor', 'system'], required: true },
    action: { type: String, required: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    reasonCode: { type: String, default: null },
    note: { type: String, default: null },
    visibleToReporter: { type: Boolean, default: true },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
eventSchema.index({ submissionId: 1, at: 1 });
export const EditorialEventModel = model<EditorialEvent>('EditorialEvent', eventSchema, 'editorial_events');

/** A reporter's request to reconsider a rejection. One per submission; decided by a different senior editor. */
export interface Appeal {
  submissionId: Types.ObjectId;
  reporterId: Types.ObjectId;
  /** The editor whose rejection is being appealed (cannot decide the appeal). */
  rejectedBy: Types.ObjectId | null;
  note: string;
  status: 'open' | 'upheld' | 'overturned';
  decidedBy: Types.ObjectId | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}
const appealSchema = new Schema<Appeal>(
  {
    submissionId: { type: Schema.Types.ObjectId, required: true },
    reporterId: { type: Schema.Types.ObjectId, required: true },
    rejectedBy: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, required: true },
    status: { type: String, enum: ['open', 'upheld', 'overturned'], default: 'open' },
    decidedBy: { type: Schema.Types.ObjectId, default: null },
    decisionNote: { type: String, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
appealSchema.index({ submissionId: 1 }, { unique: true });
appealSchema.index({ status: 1, createdAt: 1 });
appealSchema.index({ reporterId: 1, status: 1 });
export const AppealModel = model<Appeal>('Appeal', appealSchema, 'appeals');
export type AppealDoc = HydratedDocument<Appeal>;
