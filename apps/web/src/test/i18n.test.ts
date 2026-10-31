import { ERROR_CODES, ROLES, USER_STATUSES } from '@locallens/contracts';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { te } from '../i18n/te';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...acc, [key]: v } : { ...acc, ...flatten(v, key) };
  }, {});
}

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

describe('translations (AC24)', () => {
  const flatEn = flatten(en);
  const flatTe = flatten(te as Tree);

  it('Telugu and English have exactly the same keys, none empty', () => {
    expect(Object.keys(flatTe).sort()).toEqual(Object.keys(flatEn).sort());
    for (const [key, value] of Object.entries(flatTe)) expect(value.trim(), key).not.toBe('');
  });

  it('interpolation placeholders match', () => {
    for (const key of Object.keys(flatEn)) {
      expect(placeholders(flatTe[key]!), key).toEqual(placeholders(flatEn[key]!));
    }
  });

  it('every API error code, role and status has a message', () => {
    for (const code of ERROR_CODES) expect(flatEn[`errors.${code}`], code).toBeTruthy();
    for (const role of ROLES) expect(flatEn[`roles.${role}`], role).toBeTruthy();
    for (const status of USER_STATUSES) expect(flatEn[`status.${status}`], status).toBeTruthy();
    expect(flatEn['errors.NETWORK']).toBeTruthy();
  });

  it('Telugu strings are actually Telugu (catches untranslated copy-paste)', () => {
    const allowedLatin = new Set(['app.name', 'languages.en']);
    const telugu = /[ఀ-౿]/;
    for (const [key, value] of Object.entries(flatTe)) {
      if (!allowedLatin.has(key)) expect(telugu.test(value), key).toBe(true);
    }
  });
});
