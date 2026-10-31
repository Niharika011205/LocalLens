import { Schema, Types, model } from 'mongoose';
import type { Request } from 'express';
import type { Logger } from 'pino';

export interface AuditEvent {
  at: Date;
  actorId: Types.ObjectId | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
}

const auditSchema = new Schema<AuditEvent>(
  {
    at: { type: Date, required: true, default: () => new Date() },
    actorId: { type: Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, minimize: false },
);
auditSchema.index({ at: -1 });
auditSchema.index({ targetType: 1, targetId: 1, at: -1 });
auditSchema.index({ actorId: 1, at: -1 });
auditSchema.index({ action: 1, at: -1 });

export const AuditEventModel = model<AuditEvent>('AuditEvent', auditSchema, 'audit_events');

export interface AuditInput {
  action: string;
  actorId?: Types.ObjectId | string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only by convention in code (this module never updates or deletes) and by database role in production
 * (insert + find only). Audit failures are logged but do not fail the user's request: losing one audit line is
 * bad, but refusing every login because the audit insert failed would be worse.
 */
export async function audit(req: Request | null, input: AuditInput, logger?: Logger): Promise<void> {
  const actorId = input.actorId ? new Types.ObjectId(String(input.actorId)) : null;
  try {
    await AuditEventModel.create({
      action: input.action,
      actorId,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      requestId: req ? String(req.id ?? '') : null,
      ip: req?.ip ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    (req?.log ?? logger)?.error({ err, action: input.action }, 'failed to write audit event');
  }
}
