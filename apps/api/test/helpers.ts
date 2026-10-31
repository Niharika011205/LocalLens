import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp, type AppDeps } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { connectDatabase, isDatabaseReady } from '../src/db';
import { createRateLimiters, DEFAULT_LIMITS, type RateLimiters } from '../src/middleware/rate-limit';
import { ensureCategories } from '../src/modules/catalog/catalog';
import { UserModel } from '../src/modules/identity/models';

export const ORIGIN = 'http://localhost:5180';
export const PASSWORD = 'correct horse battery';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ORIGIN: ORIGIN,
    MONGODB_URI: 'mongodb://unused',
    RATE_LIMIT_STORE: 'memory',
    COOKIE_SECURE: 'false',
    // The existing approval-flow tests expect admin approval; quick-post tests turn self sign-up on.
    REPORTER_SELF_SIGNUP: 'false',
    NEWS_IMPORT: 'false', // never reach the internet from tests
    GEOCODER_ENABLED: 'false',
    ...overrides,
  });
}

/** Starts one in-memory MongoDB per test file and empties every collection before each test. */
export function useTestDb(): void {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    // A unique database per test file: even if two parallel files ever reached the same mongod, they could not
    // wipe each other's data (that showed up once as a random 401 / missing 409 under load).
    await connectDatabase(mongo.getUri(`locallens_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    const db = mongoose.connection.db!;
    const collections = await db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
    await ensureCategories(); // product configuration, recreated after the wipe
  });
}

/** Signs up a user, grants roles directly in the database, and returns a signed-in client. */
export async function userWithRoles(app: App, email: string, roles: string[]) {
  const { user } = await signUp(app, email);
  await UserModel.updateOne({ _id: user._id }, { $set: { roles } });
  return signIn(app, email);
}

export function buildApp(opts: { limiters?: RateLimiters; isReady?: AppDeps['isReady']; config?: Config } = {}) {
  const app = createApp({
    config: opts.config ?? testConfig(),
    logger: pino({ level: 'silent' }),
    limiters: opts.limiters ?? createRateLimiters({ kind: 'memory' }, DEFAULT_LIMITS),
    isReady: opts.isReady ?? isDatabaseReady,
  });
  return { app };
}

type App = ReturnType<typeof buildApp>['app'];

/** A browser-like client: keeps cookies and sends our Origin on every request, as the web app would. */
export function client(app: App) {
  const agent = request.agent(app);
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => {
      const r = agent.post(url).set('Origin', ORIGIN);
      return body === undefined ? r : r.send(body);
    },
    put: (url: string, body: object) => agent.put(url).set('Origin', ORIGIN).send(body),
    patch: (url: string, body: object) => agent.patch(url).set('Origin', ORIGIN).send(body),
    del: (url: string) => agent.delete(url).set('Origin', ORIGIN),
  };
}

/** Registers a new account; the returned client is signed in. */
export async function signUp(
  app: App,
  email: string,
  opts: { displayName?: string; requestReporter?: boolean; password?: string } = {},
) {
  const c = client(app);
  await c
    .post('/api/v1/auth/register', {
      email,
      password: opts.password ?? PASSWORD,
      displayName: opts.displayName ?? 'Test User',
      requestReporter: opts.requestReporter ?? false,
    })
    .expect(201);
  const user = (await UserModel.findOne({ email }))!;
  return { c, user };
}

/** Signs an existing account in on a fresh client. */
export async function signIn(app: App, email: string, password = PASSWORD) {
  const c = client(app);
  await c.post('/api/v1/auth/login', { email, password }).expect(200);
  return c;
}

export async function makeAdmin(email: string) {
  await UserModel.updateOne({ email }, { $addToSet: { roles: 'admin' } });
}
