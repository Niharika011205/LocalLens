import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../src/modules/audit/audit';
import { MfaChallengeModel, SessionModel, UserModel } from '../src/modules/identity/models';
import {
  base32Decode,
  base32Encode,
  currentStep,
  decryptSecret,
  encryptSecret,
  hotp,
  verifyTotp,
} from '../src/lib/totp';
import { createTree } from './fixtures';
import { buildApp, client, ORIGIN, PASSWORD, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

/** The code an authenticator app would show now (or `offset` steps away). */
const codeFor = (secret: string, offset = 0) => hotp(secret, currentStep() + offset);

describe('TOTP primitives', () => {
  it('matches the RFC 6238 test vectors (SHA-1, 6 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('accepts ±1 step of clock drift, never a replayed step, and encrypts secrets', () => {
    const secret = base32Encode(Buffer.from('abcdefghijabcdefghij'));
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, hotp(secret, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 2), { now })).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step), { now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { now })).toBeNull();
    const key = Buffer.alloc(32, 7);
    const stored = encryptSecret(secret, key);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, key)).toBe(secret);
    expect(() => decryptSecret(stored, Buffer.alloc(32, 8))).toThrow();
  });
});

async function enroll(c: ReturnType<typeof client>) {
  const setup = (await c.post('/api/v1/me/mfa/setup', { currentPassword: PASSWORD }).expect(200)).body;
  expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/LocalLens:.+\?secret=[A-Z2-7]+&issuer=LocalLens/);
  const { recoveryCodes } = (await c.post('/api/v1/me/mfa/enable', { code: codeFor(setup.secret) }).expect(200)).body;
  return { secret: setup.secret as string, recoveryCodes: recoveryCodes as string[] };
}

/** Signs in with password + second step, returning a fresh signed-in client. */
async function signInWithCode(app: Parameters<typeof client>[0], email: string, code: () => string) {
  const c = client(app);
  const first = await c.post('/api/v1/auth/login', { email, password: PASSWORD }).expect(200);
  expect(first.body).toEqual({ mfaRequired: true });
  await c.get('/api/v1/auth/me').expect(401); // the password alone does not sign in
  const second = await c.post('/api/v1/auth/mfa', { code: code() });
  return { c, res: second };
}

describe('two-step sign-in', () => {
  it('sets up with the password, confirms with a first code, then asks for a code at every sign-in', async () => {
    const { app } = buildApp();
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    await editor.post('/api/v1/me/mfa/setup', { currentPassword: 'wrong password' }).expect(400);
    const { secret, recoveryCodes } = await enroll(editor);
    expect(recoveryCodes).toHaveLength(10);
    expect((await editor.get('/api/v1/me/mfa').expect(200)).body).toMatchObject({ enabled: true, requiredForRoles: true, recoveryCodesLeft: 10 });
    expect((await editor.get('/api/v1/auth/me').expect(200)).body.user.mfa).toEqual({ enabled: true, requiredForRoles: true });

    // Stored encrypted; recovery codes only as hashes.
    const stored = await UserModel.findOne({ email: 'editor@example.in' }).lean();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]);

    // Wait for a code the setup did not use (a code is never accepted twice).
    const { c, res } = await signInWithCode(app, 'editor@example.in', () => codeFor(secret, 1));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('editor@example.in');
    await c.get('/api/v1/auth/me').expect(200);
    expect(await AuditEventModel.findOne({ action: 'auth.login_succeeded', 'metadata.mfa': 'totp' })).not.toBeNull();
  });

  it('refuses wrong and replayed codes, and drops the challenge after 5 attempts', async () => {
    const { app } = buildApp();
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const { secret } = await enroll(editor);

    // The exact code used to confirm setup cannot be used again to sign in.
    const usedStep = (await UserModel.findOne({ email: 'editor@example.in' }).lean())!.mfa.lastUsedStep;
    const replay = await signInWithCode(app, 'editor@example.in', () => hotp(secret, usedStep));
    expect(replay.res.status).toBe(400);

    const c = client(app);
    await c.post('/api/v1/auth/login', { email: 'editor@example.in', password: PASSWORD }).expect(200);
    for (let i = 0; i < 5; i++) await c.post('/api/v1/auth/mfa', { code: '000000' }).expect(400);
    // Even the right code is refused now: start again with the password.
    await c.post('/api/v1/auth/mfa', { code: codeFor(secret, 1) }).expect(401);
    expect(await MfaChallengeModel.countDocuments({ attempts: { $gte: 5 } })).toBe(0); // deleted, not just locked

    // No challenge cookie at all
    await client(app).post('/api/v1/auth/mfa', { code: '123456' }).expect(401);
  });

  it('a recovery code works once', async () => {
    const { app } = buildApp();
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const { recoveryCodes } = await enroll(editor);
    const first = await signInWithCode(app, 'editor@example.in', () => recoveryCodes[0]!.toUpperCase());
    expect(first.res.status).toBe(200);
    const again = await signInWithCode(app, 'editor@example.in', () => recoveryCodes[0]!);
    expect(again.res.status).toBe(400);
    expect((await first.c.get('/api/v1/me/mfa').expect(200)).body.recoveryCodesLeft).toBe(9);
  });

  it('turning it on signs out other devices; recovery codes can be regenerated with a code', async () => {
    const { app } = buildApp();
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const other = client(app);
    await other.post('/api/v1/auth/login', { email: 'editor@example.in', password: PASSWORD }).expect(200);
    const { secret } = await enroll(editor);
    await other.get('/api/v1/auth/me').expect(401);
    await editor.get('/api/v1/auth/me').expect(200);
    await editor.post('/api/v1/me/mfa/recovery-codes', { code: '000000' }).expect(400);
    const regenerated = (await editor.post('/api/v1/me/mfa/recovery-codes', { code: codeFor(secret, 1) }).expect(200)).body.recoveryCodes;
    expect(regenerated).toHaveLength(10);
  });

  it('when enforced, staff must turn it on before using staff tools; readers and reporters are unaffected', async () => {
    const { app } = buildApp({ config: testConfig({ MFA_ENFORCE: 'true' }) });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const reporter = await userWithRoles(app, 'reporter@example.in', ['reader', 'reporter']);

    const blocked = await admin.get('/api/v1/admin/users').expect(403);
    expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');
    await admin.get('/api/v1/articles').expect(200); // reading still works
    await reporter.get('/api/v1/submissions').expect(200); // reporters do not need it

    const { secret } = await enroll(admin);
    await admin.get('/api/v1/admin/users').expect(200);
    await createTree(admin);

    // Staff cannot turn it off while it is enforced.
    await admin.post('/api/v1/me/mfa/disable', { currentPassword: PASSWORD, code: codeFor(secret, 1) }).expect(403);
  });

  it('readers can turn it off with password + code when not required', async () => {
    const { app } = buildApp();
    const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
    const { secret } = await enroll(reader);
    expect((await reader.get('/api/v1/me/mfa').expect(200)).body.requiredForRoles).toBe(false);
    await reader.post('/api/v1/me/mfa/disable', { currentPassword: 'nope nope', code: codeFor(secret, 1) }).expect(400);
    await reader.post('/api/v1/me/mfa/disable', { currentPassword: PASSWORD, code: codeFor(secret, 1) }).expect(204);
    const res = await client(app).post('/api/v1/auth/login', { email: 'reader@example.in', password: PASSWORD }).expect(200);
    expect(res.body.user.mfa.enabled).toBe(false);
  });

  it('an admin can reset someone else\'s (lost phone), which signs them out everywhere; never their own', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    await enroll(editor);
    const editorId = (await editor.get('/api/v1/auth/me').expect(200)).body.user.id;
    const adminId = (await admin.get('/api/v1/auth/me').expect(200)).body.user.id;

    await editor.post(`/api/v1/admin/users/${adminId}/mfa/reset`, {}).set('Origin', ORIGIN).expect(403);
    await admin.post(`/api/v1/admin/users/${adminId}/mfa/reset`, {}).expect(409);
    const reset = (await admin.post(`/api/v1/admin/users/${editorId}/mfa/reset`, {}).expect(200)).body.user;
    expect(reset.mfa.enabled).toBe(false);
    expect(await SessionModel.countDocuments({ userId: editorId })).toBe(0);
    expect(await AuditEventModel.countDocuments({ action: 'admin.mfa_reset' })).toBe(1);
    const res = await client(app).post('/api/v1/auth/login', { email: 'editor@example.in', password: PASSWORD }).expect(200);
    expect(res.body.user).toBeDefined();
  });
});
