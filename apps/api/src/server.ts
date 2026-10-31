import { Redis } from 'ioredis';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './db';
import { createLogger } from './logger';
import { createRateLimiters, DEFAULT_LIMITS } from './middleware/rate-limit';
import { startWorker } from './modules/jobs/jobs';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  await connectDatabase(config.MONGODB_URI);
  logger.info('connected to MongoDB');

  let redis: Redis | undefined;
  if (config.RATE_LIMIT_STORE === 'redis') {
    // No offline queue: if Redis is down, limiter calls fail fast and the fail-open/fail-closed policy applies.
    redis = new Redis(config.REDIS_URL!, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  } else {
    logger.warn('RATE_LIMIT_STORE=memory: limits are per-process (development only)');
  }

  const app = createApp({
    config,
    logger,
    limiters: createRateLimiters(redis ? { kind: 'redis', client: redis } : { kind: 'memory' }, {
      ...DEFAULT_LIMITS,
      global: { ...DEFAULT_LIMITS.global, points: config.RATE_LIMIT_GLOBAL_PER_MIN },
    }),
    isReady: isDatabaseReady,
  });

  const server = app.listen(config.PORT, () => {
    logger.info(`LocalLens API listening on http://localhost:${config.PORT}`);
  });
  const stopWorker = config.JOBS_WORKER ? startWorker(logger) : () => undefined;

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopWorker();
    server.close(async () => {
      await disconnectDatabase();
      redis?.disconnect();
      process.exit(0);
    });
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('Fatal startup error:', err);
  }
  process.exit(1);
});
