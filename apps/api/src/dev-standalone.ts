/**
 * Runs the API with no Docker: a local MongoDB managed by mongodb-memory-server and in-memory rate limits.
 *
 * Data is kept in <repo>/.data/standalone-db so accounts survive restarts. Delete that folder to start fresh.
 * This is a single node, not a replica set, so multi-document transactions (Phase 3) need `docker compose up -d`.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const dbPath = fileURLToPath(new URL('../../../.data/standalone-db', import.meta.url));
mkdirSync(dbPath, { recursive: true });

const mongo = await MongoMemoryServer.create({
  instance: { dbPath, port: Number(process.env.STANDALONE_DB_PORT ?? 27019), storageEngine: 'wiredTiger' },
});
process.env.MONGODB_URI = mongo.getUri('locallens');
process.env.RATE_LIMIT_STORE = 'memory';
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN ??= 'http://localhost:5180';
process.env.API_PORT ??= '4100';
console.log(`[standalone] MongoDB at ${process.env.MONGODB_URI} (data in ${dbPath})`);

process.once('exit', () => void mongo.stop({ doCleanup: false }));

await import('./server');
