import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { describe, expect, it } from 'vitest';
import { createRateLimiters, DEFAULT_LIMITS } from '../src/middleware/rate-limit';
import { buildApp, client, ORIGIN, PASSWORD, signUp, useTestDb } from './helpers';

useTestDb();

const EMAIL = 'sita@example.in';

describe('CSRF defences', () => {
  it('rejects unsafe requests from a foreign or missing Origin', async () => {
    const { app } = buildApp();
    const body = { email: EMAIL, password: PASSWORD };
    const foreign = await request(app).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send(body).expect(403);
    expect(foreign.body.error.code).toBe('CSRF_REJECTED');
    const missing = await request(app).post('/api/v1/auth/login').send(body).expect(403);
    expect(missing.body.error.code).toBe('CSRF_REJECTED');
  });

  it('allows safe methods without an Origin', async () => {
    const { app } = buildApp();
    await request(app).get('/api/v1/auth/me').expect(401);
  });

  it('rejects bodies that are not JSON, and malformed JSON', async () => {
    const { app } = buildApp();
    const form = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).type('form').send(`email=${EMAIL}&password=x`).expect(415);
    expect(form.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const bad = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('input validation', () => {
  it('rejects NoSQL operator injection', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    const res = await client(app).post('/api/v1/auth/login', { email: { $gt: '' }, password: { $gt: '' } }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(['email', 'password']);
  });

  it('rejects unknown fields', async () => {
    const { app } = buildApp();
    await client(app).post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD, extra: 1 }).expect(400);
  });
});

describe('rate limiting', () => {
  it('locks an account after 5 failed logins and reports Retry-After', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    const c = client(app);
    for (let i = 0; i < 5; i++) {
      await c.post('/api/v1/auth/login', { email: EMAIL, password: 'wrong password!' }).expect(401);
    }
    // Even the correct password is refused while the account is locked.
    const locked = await c.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a successful login clears the failure counter', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    const c = client(app);
    for (let i = 0; i < 4; i++) await c.post('/api/v1/auth/login', { email: EMAIL, password: 'wrong password!' }).expect(401);
    await c.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(200);
    for (let i = 0; i < 4; i++) await c.post('/api/v1/auth/login', { email: EMAIL, password: 'wrong password!' }).expect(401);
    await c.post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(200);
  });

  it('limits registrations per IP', async () => {
    const { app } = buildApp();
    const c = client(app);
    for (let i = 0; i < DEFAULT_LIMITS.register.points; i++) {
      await c.post('/api/v1/auth/register', { email: `u${i}@example.in`, password: PASSWORD, displayName: 'User' }).expect(201);
    }
    await c.post('/api/v1/auth/register', { email: 'one-more@example.in', password: PASSWORD, displayName: 'User' }).expect(429);
  });

  it('fails closed on auth endpoints and open on others when the limiter store is down', async () => {
    const limiters = createRateLimiters({ kind: 'memory' });
    const broken = new RateLimiterMemory({ points: 1, duration: 1 });
    broken.consume = () => Promise.reject(new Error('redis down'));
    broken.get = () => Promise.reject(new Error('redis down'));
    limiters.loginIp = broken;
    limiters.loginFailuresByEmail = broken;
    limiters.global = broken;
    const { app } = buildApp({ limiters });
    const res = await client(app).post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    await request(app).get('/api/v1/auth/me').expect(401); // global limiter failed open
  });
});
