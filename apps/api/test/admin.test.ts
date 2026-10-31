import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../src/modules/audit/audit';
import { UserModel } from '../src/modules/identity/models';
import { promoteToAdmin } from '../src/scripts/promote-admin';
import { buildApp, client, makeAdmin, signIn, signUp, useTestDb } from './helpers';

useTestDb();

const ADMIN = 'admin@example.in';
const READER = 'lakshmi@example.in';

async function setup(opts: { readerWantsReporter?: boolean } = {}) {
  const { app } = buildApp();
  await signUp(app, ADMIN, { displayName: 'Admin Person' });
  await makeAdmin(ADMIN);
  const admin = await signIn(app, ADMIN);
  const { c: reader, user: readerUser } = await signUp(app, READER, {
    displayName: 'Lakshmi',
    requestReporter: opts.readerWantsReporter ?? false,
  });
  const adminUser = (await UserModel.findOne({ email: ADMIN }))!;
  return { app, admin, adminUser, reader, readerUser };
}

describe('admin authorization', () => {
  it('anonymous gets 401 and non-admins get 403 on every admin endpoint', async () => {
    const { app, reader, readerUser } = await setup();
    const anon = client(app);
    const id = readerUser.id;
    await anon.get('/api/v1/admin/users').expect(401);
    await reader.get('/api/v1/admin/users').expect(403);
    await reader.put(`/api/v1/admin/users/${id}/roles`, { roles: ['admin'] }).expect(403);
    await reader.post(`/api/v1/admin/users/${id}/suspend`, { reason: 'test' }).expect(403);
    await reader.post(`/api/v1/admin/users/${id}/reactivate`).expect(403);
    await reader.post(`/api/v1/admin/users/${id}/reporter-request`, { decision: 'approve' }).expect(403);
    await reader.post(`/api/v1/admin/users/${id}/reset-password`).expect(403);
    expect((await UserModel.findById(id))?.roles).toEqual(['reader']);
  });
});

describe('role management', () => {
  it('admin can grant roles, and the change is audited', async () => {
    const { admin, readerUser } = await setup();
    const res = await admin.put(`/api/v1/admin/users/${readerUser.id}/roles`, { roles: ['reader', 'editor'] }).expect(200);
    expect(res.body.user.roles).toEqual(['reader', 'editor']);
    const event = await AuditEventModel.findOne({ action: 'admin.roles_changed' }).lean();
    expect(event?.metadata).toEqual({ before: ['reader'], after: ['reader', 'editor'] });
  });

  it('rejects unknown roles and duplicates', async () => {
    const { admin, readerUser } = await setup();
    await admin.put(`/api/v1/admin/users/${readerUser.id}/roles`, { roles: ['superuser'] }).expect(400);
    await admin.put(`/api/v1/admin/users/${readerUser.id}/roles`, { roles: ['reader', 'reader'] }).expect(400);
  });

  it('an admin cannot remove their own admin role', async () => {
    const { admin, adminUser } = await setup();
    const res = await admin.put(`/api/v1/admin/users/${adminUser.id}/roles`, { roles: ['reader'] }).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 400 for malformed ids and 404 for unknown users', async () => {
    const { admin } = await setup();
    await admin.put('/api/v1/admin/users/not-an-id/roles', { roles: ['reader'] }).expect(400);
    await admin.put('/api/v1/admin/users/0123456789abcdef01234567/roles', { roles: ['reader'] }).expect(404);
  });

  it('lists users with keyset pagination and email/name prefix search', async () => {
    const { admin } = await setup();
    const page1 = await admin.get('/api/v1/admin/users?limit=1').expect(200);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await admin.get(`/api/v1/admin/users?limit=1&cursor=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);

    const byEmail = await admin.get('/api/v1/admin/users?q=LAKS').expect(200);
    expect(byEmail.body.items.map((u: { email: string }) => u.email)).toEqual([READER]);
    const byName = await admin.get('/api/v1/admin/users?q=admin%20per').expect(200);
    expect(byName.body.items.map((u: { email: string }) => u.email)).toEqual([ADMIN]);
    await admin.get('/api/v1/admin/users?q=.*').expect(200, { items: [], nextCursor: null });
  });
});

describe('reporter requests', () => {
  it('lists pending requests; approving grants the reporter role', async () => {
    const { admin, readerUser } = await setup({ readerWantsReporter: true });
    const pending = await admin.get('/api/v1/admin/users?reporterRequest=pending').expect(200);
    expect(pending.body.items.map((u: { id: string }) => u.id)).toEqual([readerUser.id]);

    const res = await admin
      .post(`/api/v1/admin/users/${readerUser.id}/reporter-request`, { decision: 'approve', note: 'Known contributor' })
      .expect(200);
    expect(res.body.user.roles).toEqual(['reader', 'reporter']);
    expect(res.body.user.reporterRequest).toMatchObject({ status: 'approved', note: 'Known contributor' });
    expect(await AuditEventModel.countDocuments({ action: 'admin.reporter_approved' })).toBe(1);
    await admin.get('/api/v1/admin/users?reporterRequest=pending').expect(200, { items: [], nextCursor: null });
  });

  it('rejecting keeps the user a reader, and they may ask again later', async () => {
    const { admin, reader, readerUser } = await setup({ readerWantsReporter: true });
    const res = await admin
      .post(`/api/v1/admin/users/${readerUser.id}/reporter-request`, { decision: 'reject', note: 'Please add more detail' })
      .expect(200);
    expect(res.body.user.roles).toEqual(['reader']);
    expect(res.body.user.reporterRequest.status).toBe('rejected');
    await reader.post('/api/v1/me/reporter-request').expect(200);
  });

  it('deciding without a pending request is a conflict', async () => {
    const { admin, readerUser } = await setup();
    await admin.post(`/api/v1/admin/users/${readerUser.id}/reporter-request`, { decision: 'approve' }).expect(409);
  });

  it('granting reporter through roles also settles a pending request', async () => {
    const { admin, readerUser } = await setup({ readerWantsReporter: true });
    const res = await admin.put(`/api/v1/admin/users/${readerUser.id}/roles`, { roles: ['reader', 'reporter'] }).expect(200);
    expect(res.body.user.reporterRequest.status).toBe('approved');
  });
});

describe('admin password reset', () => {
  it('issues a one-time temporary password, signs the user out, and requires a change', async () => {
    const { app, admin, reader, readerUser } = await setup();
    const res = await admin.post(`/api/v1/admin/users/${readerUser.id}/reset-password`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const temp: string = res.body.temporaryPassword;
    expect(temp).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(JSON.stringify(await AuditEventModel.find().lean())).not.toContain(temp);

    await reader.get('/api/v1/auth/me').expect(401);
    const c = await signIn(app, READER, temp);
    const me = await c.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    const changed = await c.put('/api/v1/me/password', { currentPassword: temp, newPassword: 'my own new password' }).expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
  });

  it('an admin cannot reset their own password this way', async () => {
    const { admin, adminUser } = await setup();
    await admin.post(`/api/v1/admin/users/${adminUser.id}/reset-password`).expect(409);
  });
});

describe('suspension', () => {
  it('revokes sessions immediately and blocks sign-in until reactivated', async () => {
    const { app, admin, reader, readerUser } = await setup();
    await reader.get('/api/v1/auth/me').expect(200);
    await admin.post(`/api/v1/admin/users/${readerUser.id}/suspend`, { reason: 'Repeated abusive reports' }).expect(200);
    await reader.get('/api/v1/auth/me').expect(401);
    await expect(signIn(app, READER)).rejects.toThrow();

    await admin.post(`/api/v1/admin/users/${readerUser.id}/reactivate`).expect(200);
    await signIn(app, READER);
  });

  it('an admin cannot suspend themselves', async () => {
    const { admin, adminUser } = await setup();
    await admin.post(`/api/v1/admin/users/${adminUser.id}/suspend`, { reason: 'oops' }).expect(409);
  });
});

describe('admin:promote CLI', () => {
  it('promotes an existing account and refuses unknown or invalid emails', async () => {
    const { app } = buildApp();
    await signUp(app, 'editor@example.in');
    expect(await promoteToAdmin('Editor@Example.in')).toEqual({ ok: true, message: 'editor@example.in is now an admin' });
    expect((await UserModel.findOne({ email: 'editor@example.in' }))?.roles).toContain('admin');
    expect((await promoteToAdmin('ghost@example.in')).ok).toBe(false);
    expect((await promoteToAdmin('not-an-email')).ok).toBe(false);
    expect(await AuditEventModel.countDocuments({ action: 'admin.promoted_via_cli' })).toBe(1);
  });
});
