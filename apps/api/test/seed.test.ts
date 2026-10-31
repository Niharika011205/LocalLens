import { describe, expect, it } from 'vitest';
import { UserModel } from '../src/modules/identity/models';
import { DEV_ACCOUNTS, DEV_PASSWORD, isLocalMongoUri, seedDevAccounts } from '../src/scripts/seed-dev';
import { buildApp, signIn, useTestDb } from './helpers';

useTestDb();

describe('seed:dev', () => {
  it('creates accounts that can sign in, and is idempotent', async () => {
    await seedDevAccounts();
    await seedDevAccounts();
    expect(await UserModel.countDocuments()).toBe(DEV_ACCOUNTS.length);

    const { app } = buildApp();
    const c = await signIn(app, 'admin@locallens.test', DEV_PASSWORD);
    const me = await c.get('/api/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({ status: 'active', roles: ['reader', 'admin'], mustChangePassword: false });
  });

  it('only accepts local database URIs', () => {
    expect(isLocalMongoUri('mongodb://localhost:27018/locallens?directConnection=true')).toBe(true);
    expect(isLocalMongoUri('mongodb://127.0.0.1:27019/locallens')).toBe(true);
    expect(isLocalMongoUri('mongodb://mongo:27017/locallens?replicaSet=rs0')).toBe(true);
    expect(isLocalMongoUri('mongodb+srv://user:pw@cluster0.example.mongodb.net/locallens')).toBe(false);
    expect(isLocalMongoUri('mongodb://user:pw@db.example.com:27017/locallens')).toBe(false);
    expect(isLocalMongoUri('mongodb://localhost:27017,db.example.com:27017/x')).toBe(false);
  });
});
