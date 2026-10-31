import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
// @node-rs/argon2 uses Argon2id by default; a test asserts the "$argon2id$" prefix.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 256-bit random token, URL-safe. Used for session cookies. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are high-entropy, so a fast hash is enough to make a stolen database useless for impersonation. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Temporary password for admin resets: 12 characters from an alphabet without look-alikes (0/O, 1/l/I),
 * so it can be read out over the phone. ~68 bits of entropy.
 */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
