import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto';
import { AuditEventModel } from '../src/modules/audit/audit';
import { SessionModel, UserModel } from '../src/modules/identity/models';
import { buildApp, client, PASSWORD, signIn, signUp, useTestDb } from './helpers';

useTestDb();

const EMAIL = 'ravi@example.in';

function sessionCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = list.find((c) => c.startsWith('ll_session='));
  if (!cookie) throw new Error('no session cookie set');
  return cookie;
}

describe('registration', () => {
  it('creates a reader, signs in immediately, and stores only an Argon2id hash', async () => {
    const { app } = buildApp();
    const c = client(app);
    const res = await c
      .post('/api/v1/auth/register', { email: ' Ravi@Example.IN ', password: PASSWORD, displayName: 'Ravi', preferredLanguage: 'en' })
      .expect(201);
    expect(res.body.user).toMatchObject({
      email: EMAIL,
      displayName: 'Ravi',
      preferredLanguage: 'en',
      roles: ['reader'],
      status: 'active',
      mustChangePassword: false,
      reporterRequest: { status: 'none' },
    });
    sessionCookie(res.headers['set-cookie']);
    await c.get('/api/v1/auth/me').expect(200);

    const stored = await UserModel.findOne({ email: EMAIL }).lean();
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it('asking to report news creates a pending request but grants nothing', async () => {
    const { app } = buildApp();
    const { user } = await signUp(app, EMAIL, { requestReporter: true });
    expect(user.roles).toEqual(['reader']);
    expect(user.reporterRequest.status).toBe('pending');
  });

  it('roles cannot be chosen at registration', async () => {
    const { app } = buildApp();
    const res = await client(app)
      .post('/api/v1/auth/register', { email: EMAIL, password: PASSWORD, displayName: 'Ravi', roles: ['admin'] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('rejects an email that is already registered, in any letter case', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    const res = await client(app)
      .post('/api/v1/auth/register', { email: 'RAVI@example.in', password: 'another password', displayName: 'Other' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('enforces password length 8–128', async () => {
    const { app } = buildApp();
    const c = client(app);
    await c.post('/api/v1/auth/register', { email: EMAIL, password: 'short', displayName: 'Ravi' }).expect(400);
    await c.post('/api/v1/auth/register', { email: EMAIL, password: 'x'.repeat(129), displayName: 'Ravi' }).expect(400);
    await c.post('/api/v1/auth/register', { email: EMAIL, password: 'eightchr', displayName: 'Ravi' }).expect(201);
  });
});

describe('sign-in', () => {
  it('sets an HttpOnly SameSite=Lax cookie and stores only its hash', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    await SessionModel.deleteMany({});
    const res = await client(app).post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(200);
    const cookie = sessionCookie(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const raw = cookie.split(';')[0]!.split('=')[1]!;
    const sessions = await SessionModel.find().lean();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(sha256(raw));
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    const c = client(app);
    const unknown = await c.post('/api/v1/auth/login', { email: 'ghost@example.in', password: PASSWORD }).expect(401);
    const wrong = await c.post('/api/v1/auth/login', { email: EMAIL, password: 'not the password' }).expect(401);
    const strip = (b: { error: { requestId?: string } }) => ({ ...b.error, requestId: undefined });
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
  });

  it('suspended accounts cannot sign in', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    await UserModel.updateOne({ email: EMAIL }, { $set: { status: 'suspended' } });
    const res = await client(app).post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('sessions', () => {
  it('logout invalidates the session server-side', async () => {
    const { app } = buildApp();
    const { c } = await signUp(app, EMAIL);
    const other = await signIn(app, EMAIL);
    await c.post('/api/v1/auth/logout').expect(204);
    await c.get('/api/v1/auth/me').expect(401);
    await other.get('/api/v1/auth/me').expect(200); // other device unaffected
  });

  it('logout-all revokes every session of the user', async () => {
    const { app } = buildApp();
    const { c: phone } = await signUp(app, EMAIL);
    const laptop = await signIn(app, EMAIL);
    await phone.post('/api/v1/auth/logout-all').expect(204);
    await laptop.get('/api/v1/auth/me').expect(401);
    expect(await SessionModel.countDocuments()).toBe(0);
  });

  it('expired sessions are rejected', async () => {
    const { app } = buildApp();
    const { c } = await signUp(app, EMAIL);
    await SessionModel.updateMany({}, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    await c.get('/api/v1/auth/me').expect(401);
  });
});

describe('changing password', () => {
  it('requires the current password and signs out other devices only', async () => {
    const { app } = buildApp();
    const { c } = await signUp(app, EMAIL);
    const otherDevice = await signIn(app, EMAIL);

    const wrong = await c.put('/api/v1/me/password', { currentPassword: 'nope', newPassword: 'a new passphrase' }).expect(400);
    expect(wrong.body.error.details[0].path).toBe('currentPassword');

    await c.put('/api/v1/me/password', { currentPassword: PASSWORD, newPassword: 'a new passphrase' }).expect(200);
    await c.get('/api/v1/auth/me').expect(200);
    await otherDevice.get('/api/v1/auth/me').expect(401);
    await client(app).post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }).expect(401);
    await signIn(app, EMAIL, 'a new passphrase');
  });
});

describe('profile and reporter requests', () => {
  it('updates display name and language, rejects role changes', async () => {
    const { app } = buildApp();
    const { c } = await signUp(app, EMAIL);
    const res = await c.patch('/api/v1/me', { displayName: 'Ravi Kumar', preferredLanguage: 'en' }).expect(200);
    expect(res.body.user).toMatchObject({ displayName: 'Ravi Kumar', preferredLanguage: 'en' });
    await c.patch('/api/v1/me', { displayName: 'X Y', roles: ['admin'] }).expect(400);
    expect((await UserModel.findOne({ email: EMAIL }))?.roles).toEqual(['reader']);
  });

  it('a reader can ask for reporter access once at a time', async () => {
    const { app } = buildApp();
    const { c } = await signUp(app, EMAIL);
    const res = await c.post('/api/v1/me/reporter-request').expect(200);
    expect(res.body.user.reporterRequest.status).toBe('pending');
    expect(res.body.user.roles).toEqual(['reader']);
    await c.post('/api/v1/me/reporter-request').expect(409);
  });

  it('requires sign-in', async () => {
    const { app } = buildApp();
    await client(app).patch('/api/v1/me', { displayName: 'Nobody' }).expect(401);
    await client(app).post('/api/v1/me/reporter-request').expect(401);
    await client(app).put('/api/v1/me/password', { currentPassword: 'x', newPassword: 'whatever123' }).expect(401);
  });
});

describe('audit log', () => {
  it('records auth events without secrets', async () => {
    const { app } = buildApp();
    await signUp(app, EMAIL);
    await client(app).post('/api/v1/auth/login', { email: EMAIL, password: 'wrong password!' }).expect(401);
    const actions = (await AuditEventModel.find().sort({ _id: 1 }).lean()).map((e) => e.action);
    expect(actions).toEqual(['auth.registered', 'auth.login_failed']);
    const all = JSON.stringify(await AuditEventModel.find().lean());
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('passwordHash');
  });
});

describe('session check', () => {
  it('answers 200 with user null when signed out, and the user when signed in (no 401 noise for visitors)', async () => {
    const { app } = buildApp();
    const anon = await client(app).get('/api/v1/auth/session').expect(200);
    expect(anon.body).toEqual({ user: null });
    expect(anon.headers['cache-control']).toBe('no-store');
    const { c } = await signUp(app, 'session@example.in');
    expect((await c.get('/api/v1/auth/session').expect(200)).body.user).toMatchObject({ email: 'session@example.in' });
    await client(app).get('/api/v1/auth/me').expect(401); // the strict endpoint is unchanged
  });
});
