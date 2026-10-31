/**
 * Creates (or resets) one test account per role for LOCAL development and testing.
 *
 *   npm run seed:dev
 *
 * Refuses to run when NODE_ENV=production or when MONGODB_URI does not point at this machine, so these well-known
 * credentials can never end up in a shared or deployed database. The accounts are listed in docs/dev-test-accounts.md.
 */
import type { Role } from '@locallens/contracts';
import { connectDatabase, disconnectDatabase } from '../db';
import { hashPassword } from '../lib/crypto';
import { AuditEventModel } from '../modules/audit/audit';
import { UserModel } from '../modules/identity/models';

/** Development-only password shared by all seeded accounts. Never valid anywhere else. */
export const DEV_PASSWORD = 'LocalLens-dev-pass-2026';

export const DEV_ACCOUNTS: { email: string; displayName: string; roles: Role[] }[] = [
  { email: 'reader@locallens.test', displayName: 'Test Reader', roles: ['reader'] },
  { email: 'reporter@locallens.test', displayName: 'Test Reporter', roles: ['reader', 'reporter'] },
  { email: 'editor@locallens.test', displayName: 'Test Editor', roles: ['reader', 'editor'] },
  { email: 'admin@locallens.test', displayName: 'Test Admin', roles: ['reader', 'admin'] },
];

export function isLocalMongoUri(uri: string): boolean {
  const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0] ?? '';
  return host.split(',').every((h) => /^(localhost|127\.0\.0\.1|\[::1\]|mongo)(:\d+)?$/.test(h));
}

/** Idempotent: re-running resets these accounts to their documented state (password, roles, active). */
export async function seedDevAccounts(): Promise<string[]> {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  for (const account of DEV_ACCOUNTS) {
    await UserModel.updateOne(
      { email: account.email },
      {
        $set: {
          ...account,
          passwordHash,
          mustChangePassword: false,
          status: 'active',
          preferredLanguage: 'te',
          reporterRequest: { status: 'none', requestedAt: null, decidedAt: null, decidedBy: null, note: null },
        },
      },
      { upsert: true },
    );
  }
  await AuditEventModel.create({ action: 'dev.seed_accounts', metadata: { emails: DEV_ACCOUNTS.map((a) => a.email) } });
  return DEV_ACCOUNTS.map((a) => `${a.email}  (${a.roles.join(', ')})`);
}

async function cli(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed test accounts with NODE_ENV=production.');
    process.exit(1);
  }
  if (!uri || !isLocalMongoUri(uri)) {
    console.error('Refusing to seed: MONGODB_URI must point at a local database (localhost / 127.0.0.1 / docker "mongo").');
    process.exit(1);
  }
  await connectDatabase(uri);
  try {
    const lines = await seedDevAccounts();
    console.log('Seeded test accounts (password in docs/dev-test-accounts.md):');
    for (const line of lines) console.log(`  ${line}`);
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && /seed-dev\.(ts|js)$/.test(process.argv[1])) {
  await cli();
}
