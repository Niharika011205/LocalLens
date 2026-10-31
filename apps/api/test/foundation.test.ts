import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { buildApp, testConfig, useTestDb } from './helpers';

useTestDb();

describe('configuration (AC3)', () => {
  const base = { APP_ORIGIN: 'http://localhost:5180', MONGODB_URI: 'mongodb://x', RATE_LIMIT_STORE: 'memory' };

  it('refuses to start without required variables', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/APP_ORIGIN/);
    expect(() => loadConfig({})).toThrow(/MONGODB_URI/);
  });

  it('requires REDIS_URL for the redis rate-limit store', () => {
    expect(() => loadConfig({ ...base, RATE_LIMIT_STORE: 'redis' })).toThrow(/REDIS_URL/);
  });

  it('API_PORT takes precedence over an injected PORT', () => {
    expect(loadConfig({ ...base, PORT: '5180', API_PORT: '4100' }).PORT).toBe(4100);
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects unsafe production settings', () => {
    const run = () => loadConfig({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'http://news.example', COOKIE_SECURE: 'false' });
    expect(run).toThrow(/COOKIE_SECURE/);
    expect(run).toThrow(/RATE_LIMIT_STORE/);
    expect(run).toThrow(/APP_ORIGIN/);
    expect(run).toThrow(/MFA_ENFORCE/);
    expect(run).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, MFA_ENCRYPTION_KEY: 'too-short' })).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('starts with the settings render.yaml provides; the address comes from RENDER_EXTERNAL_URL', () => {
    const render = {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb+srv://u:p@cluster0.example.mongodb.net/locallens',
      RATE_LIMIT_STORE: 'redis',
      REDIS_URL: 'redis://red-abc:6379',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
      MFA_ENFORCE: 'true',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), // what Render's generateValue produces: 256 bits, base64
      PORT: '10000',
      RENDER_EXTERNAL_URL: 'https://locallens.onrender.com',
    };
    const config = loadConfig(render);
    expect(config).toMatchObject({ APP_ORIGIN: 'https://locallens.onrender.com', PORT: 10000, TRUST_PROXY: 1 });
    expect(config.AI_SERVICE_URL).toBeUndefined(); // Ask AI is off online
    expect(loadConfig({ ...render, APP_ORIGIN: 'https://news.example.in' }).APP_ORIGIN).toBe('https://news.example.in');
  });
});

describe('health (AC4)', () => {
  it('healthz is always ok', async () => {
    const { app } = buildApp();
    await request(app).get('/healthz').expect(200, { status: 'ok' });
  });

  it('readyz is 200 when MongoDB is reachable', async () => {
    const { app } = buildApp();
    await request(app).get('/readyz').expect(200, { status: 'ready' });
  });

  it('readyz is 503 when a dependency is down', async () => {
    const { app } = buildApp({ isReady: async () => false });
    await request(app).get('/readyz').expect(503, { status: 'not_ready' });
  });
});

describe('request ids and errors (AC5)', () => {
  it('adds X-Request-Id to every response and echoes a valid incoming one', async () => {
    const { app } = buildApp();
    const fresh = await request(app).get('/healthz');
    expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app).get('/healthz').set('X-Request-Id', 'proxy-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('proxy-abc-12345');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: res.headers['x-request-id'] },
    });
  });
});

describe('security headers (AC6)', () => {
  it('sets CSP, nosniff and frame-ancestors none, and hides X-Powered-By', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/healthz');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS and upgrade-insecure-requests only in production', async () => {
    const dev = await request(buildApp().app).get('/healthz');
    expect(dev.headers['strict-transport-security']).toBeUndefined();
    const prodConfig = testConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://news.example',
      COOKIE_SECURE: 'true',
      RATE_LIMIT_STORE: 'redis',
      REDIS_URL: 'redis://unused',
      MFA_ENFORCE: 'true',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    const prod = await request(buildApp({ config: prodConfig }).app).get('/healthz');
    expect(prod.headers['strict-transport-security']).toContain('max-age=');
    expect(prod.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});
