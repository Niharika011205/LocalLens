/**
 * Grants the admin role to an existing account. This is the only way to create the first admin: there is
 * deliberately no HTTP endpoint for it.
 *
 *   npm run admin:promote -- you@example.com
 */
import { parseArgs } from 'node:util';
import { Email } from '@locallens/contracts';
import { connectDatabase, disconnectDatabase } from '../db';
import { AuditEventModel } from '../modules/audit/audit';
import { UserModel } from '../modules/identity/models';

export async function promoteToAdmin(rawEmail: string): Promise<{ ok: boolean; message: string }> {
  const parsed = Email.safeParse(rawEmail);
  if (!parsed.success) return { ok: false, message: `Not a valid email address: ${rawEmail}` };
  const email = parsed.data;
  const user = await UserModel.findOne({ email });
  if (!user) return { ok: false, message: `No account found for ${email}` };
  if (user.status !== 'active') return { ok: false, message: `Account ${email} is ${user.status}` };
  if (user.roles.includes('admin')) return { ok: true, message: `${email} is already an admin` };
  await UserModel.updateOne({ _id: user._id }, { $addToSet: { roles: 'admin' } });
  await AuditEventModel.create({
    action: 'admin.promoted_via_cli',
    actorId: null,
    targetType: 'user',
    targetId: user.id,
    metadata: { osUser: process.env.USERNAME ?? process.env.USER ?? 'unknown' },
  });
  return { ok: true, message: `${email} is now an admin` };
}

async function cli(): Promise<void> {
  // Positional or --email: PowerShell strips a bare `--`, so flags after `npm run x --` can arrive without their name.
  const { values, positionals } = parseArgs({ options: { email: { type: 'string' } }, allowPositionals: true });
  const email = values.email ?? positionals[0];
  const uri = process.env.MONGODB_URI;
  if (!email || !uri) {
    console.error('Usage: npm run admin:promote -- you@example.com   (MONGODB_URI must be set, e.g. in .env)');
    process.exit(2);
  }
  await connectDatabase(uri);
  try {
    const result = await promoteToAdmin(email);
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await disconnectDatabase();
  }
}

// Run only when executed directly, so tests can import promoteToAdmin.
if (process.argv[1] && /promote-admin\.(ts|js)$/.test(process.argv[1])) {
  await cli();
}
