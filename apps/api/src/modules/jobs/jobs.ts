import { randomUUID } from 'node:crypto';
import { Schema, model, type HydratedDocument } from 'mongoose';
import type { Logger } from 'pino';

/**
 * A small durable job queue stored in MongoDB.
 *
 * Why not BullMQ/Redis here: the job record has to be durable in MongoDB anyway (the "outbox" — if the API crashes
 * between saving a submission and enqueueing its job, a sweeper must be able to find and repair it). Keeping the queue
 * in the same database removes Redis as a hard dependency for background work and keeps the pilot cheap. The JobQueue
 * functions below are the seam where BullMQ can be swapped in if throughput ever needs it.
 *
 * Semantics:
 * - At-least-once: a worker leases a job; if it crashes, the lease expires and another worker picks it up.
 *   Handlers must therefore be idempotent.
 * - Retries only for transient failures, with exponential backoff and full jitter, up to maxAttempts.
 * - Permanent failures are not retried.
 * - A per-type circuit breaker stops hammering a dependency that keeps failing.
 */

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job {
  type: string;
  payload: Record<string, unknown>;
  /** Unique when set: enqueueing the same logical job twice is a no-op. */
  dedupeKey: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export type JobDoc = HydratedDocument<Job>;

const jobSchema = new Schema<Job>(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, default: null },
    status: { type: String, enum: ['pending', 'running', 'succeeded', 'failed', 'dead'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    runAfter: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, minimize: false },
);
jobSchema.index({ status: 1, type: 1, runAfter: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
// Finished jobs are kept for 30 days for debugging, then removed.
jobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: { $in: ['succeeded', 'failed', 'dead'] } } });

export const JobModel = model<Job>('Job', jobSchema, 'jobs');

/** Throw this from a handler to signal "do not retry". Any other error is treated as transient. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

export interface JobHandler {
  run(job: JobDoc): Promise<void>;
  /** Called once when a job will not be retried any more (permanent failure or attempts exhausted). */
  onGiveUp?(job: JobDoc, reason: 'permanent' | 'exhausted', error: string): Promise<void>;
}

const handlers = new Map<string, JobHandler>();
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function enqueue(type: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; maxAttempts?: number } = {}): Promise<void> {
  try {
    await JobModel.create({ type, payload, dedupeKey: opts.dedupeKey ?? null, maxAttempts: opts.maxAttempts ?? 6 });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // already queued
    throw err;
  }
}

export const RETRY = { baseMs: 5_000, capMs: 10 * 60_000 };
/** Exponential backoff with full jitter: random delay in [0, min(cap, base * 2^attempt)). Spreads retries out. */
export function backoffMs(attempt: number, random = Math.random): number {
  return Math.floor(random() * Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt));
}

// ---------- circuit breaker (per job type, per process) ----------
const BREAKER = { threshold: 5, openMs: 2 * 60_000 };
const breakers = new Map<string, { failures: number; openUntil: number }>();
/** Job types whose circuit breaker is currently open (for the ops dashboard). */
export function openBreakers(now = Date.now()): string[] {
  return [...breakers.entries()].filter(([, b]) => b.openUntil > now).map(([type]) => type);
}
export function breakerOpen(type: string, now = Date.now()): boolean {
  return (breakers.get(type)?.openUntil ?? 0) > now;
}
function recordTransientFailure(type: string, now = Date.now()) {
  const b = breakers.get(type) ?? { failures: 0, openUntil: 0 };
  b.failures++;
  if (b.failures >= BREAKER.threshold) {
    b.openUntil = now + BREAKER.openMs;
    b.failures = 0;
  }
  breakers.set(type, b);
}
function recordSuccess(type: string) {
  breakers.set(type, { failures: 0, openUntil: 0 });
}
export function resetBreakers(): void {
  breakers.clear();
}

const LEASE_MS = 15 * 60_000;
const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

async function claimNext(): Promise<JobDoc | null> {
  const now = new Date();
  const types = [...handlers.keys()].filter((t) => !breakerOpen(t));
  if (!types.length) return null;
  return JobModel.findOneAndUpdate(
    {
      type: { $in: types },
      $or: [
        { status: 'pending', runAfter: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } }, // a crashed worker's job
      ],
    },
    { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LEASE_MS), lockedBy: WORKER_ID }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1 }, new: true },
  );
}

async function processJob(job: JobDoc, logger: Logger): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) return;
  try {
    await handler.run(job);
    recordSuccess(job.type);
    await JobModel.updateOne({ _id: job._id }, { $set: { status: 'succeeded', lockedUntil: null, lastError: null } });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const permanent = err instanceof PermanentJobError;
    if (!permanent) recordTransientFailure(job.type);
    const exhausted = !permanent && job.attempts >= job.maxAttempts;
    if (permanent || exhausted) {
      logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, permanent, err: message }, 'job gave up');
      await JobModel.updateOne({ _id: job._id }, { $set: { status: permanent ? 'failed' : 'dead', lockedUntil: null, lastError: message } });
      await handler.onGiveUp?.(job, permanent ? 'permanent' : 'exhausted', message);
    } else {
      const delay = backoffMs(job.attempts);
      logger.info({ jobId: job.id, type: job.type, attempts: job.attempts, retryInMs: delay, err: message }, 'job will retry');
      await JobModel.updateOne(
        { _id: job._id },
        { $set: { status: 'pending', lockedUntil: null, lastError: message, runAfter: new Date(Date.now() + delay) } },
      );
    }
  }
}

/** Processes jobs until none are due (or `max` were run). Used by the worker loop and directly by tests. */
export async function runDueJobs(logger: Logger, max = 50): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimNext();
    if (!job) break;
    await processJob(job, logger);
  }
  return n;
}

type Sweeper = () => Promise<void>;
const sweepers = new Map<string, Sweeper>();
/** Periodic repair tasks (e.g. re-enqueue work whose job was lost in a crash). Registering a name again replaces it. */
export function registerSweeper(name: string, fn: Sweeper): void {
  sweepers.set(name, fn);
}
/** Runs every sweeper once (the worker does this every minute; tests call it directly). */
export async function runSweepers(logger: Logger): Promise<void> {
  for (const [name, fn] of sweepers) await fn().catch((err) => logger.error({ err, sweeper: name }, 'sweeper failed'));
}

export function startWorker(logger: Logger, opts: { pollMs?: number; sweepMs?: number } = {}): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runDueJobs(logger);
    } catch (err) {
      logger.error({ err }, 'job worker tick failed');
    } finally {
      running = false;
    }
  };
  const sweep = () => runSweepers(logger);
  const poll = setInterval(() => void tick(), opts.pollMs ?? 2_000);
  const sweepTimer = setInterval(() => void sweep(), opts.sweepMs ?? 60_000);
  void sweep();
  logger.info({ worker: WORKER_ID }, 'job worker started');
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(sweepTimer);
  };
}
