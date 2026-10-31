import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { LocationLevel } from '@locallens/contracts';
import { buildSearchKeys, LocationModel, normaliseKey, type LocationDoc } from './location.model';

/**
 * Imports villages from a Local Government Directory (LGD) CSV export.
 *
 * Column names differ slightly between the LGD portal and data.gov.in, so headers are matched case-insensitively
 * against several known spellings. Each row describes one village with its state, district and sub-district
 * (mandal); missing parents are created on the way.
 *
 * Rules:
 *  - Matching is by (level, LGD code) first, then by name under the same parent — so places an admin added by hand
 *    get their LGD code attached instead of being duplicated.
 *  - Re-running the same file changes nothing (idempotent).
 *  - Existing Telugu names typed by admins are never overwritten with blanks.
 */

type Field = 'stateCode' | 'stateName' | 'districtCode' | 'districtName' | 'mandalCode' | 'mandalName' | 'villageCode' | 'villageName' | 'villageNameTe';

const HEADER_ALIASES: Record<Field, string[]> = {
  stateCode: ['statecode', 'state code', 'state_code', 'state lgd code'],
  stateName: ['statenameenglish', 'state name (in english)', 'state name', 'statename', 'state_name'],
  districtCode: ['districtcode', 'district code', 'district_code', 'district lgd code'],
  districtName: ['districtnameenglish', 'district name (in english)', 'district name', 'districtname', 'district_name'],
  mandalCode: ['subdistrictcode', 'sub-district code', 'sub district code', 'subdistrict_code', 'sub-district lgd code'],
  mandalName: ['subdistrictnameenglish', 'sub-district name (in english)', 'sub-district name', 'sub district name (in english)', 'sub district name', 'subdistrictname', 'subdistrict_name'],
  villageCode: ['villagecode', 'village code', 'village_code', 'village lgd code'],
  villageName: ['villagenameenglish', 'village name (in english)', 'village name', 'villagename', 'village_name'],
  villageNameTe: ['villagenamelocal', 'village name (in local language)', 'village name (in local)', 'village name local', 'villagename_local', 'local name'],
};
const REQUIRED: Field[] = ['stateCode', 'stateName', 'districtCode', 'districtName', 'mandalCode', 'mandalName', 'villageCode', 'villageName'];

/** RFC 4180-style CSV parsing (quoted fields, escaped quotes, CRLF). No dependency needed for this. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export interface LgdRow {
  stateCode: string;
  stateName: string;
  districtCode: string;
  districtName: string;
  mandalCode: string;
  mandalName: string;
  villageCode: string;
  villageName: string;
  villageNameTe: string | null;
}

export function readLgdRows(text: string): LgdRow[] {
  const [header, ...data] = parseCsv(text);
  if (!header) throw new Error('The file is empty');
  const normalised = header.map((h) => h.trim().toLowerCase());
  const index = {} as Record<Field, number>;
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    index[field] = normalised.findIndex((h) => HEADER_ALIASES[field].includes(h));
  }
  const missing = REQUIRED.filter((f) => index[f] < 0);
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}. Found: ${header.join(', ')}`);

  return data.map((cells, i) => {
    const get = (f: Field) => (index[f] >= 0 ? (cells[index[f]] ?? '').trim() : '');
    const row: LgdRow = {
      stateCode: get('stateCode'),
      stateName: get('stateName'),
      districtCode: get('districtCode'),
      districtName: get('districtName'),
      mandalCode: get('mandalCode'),
      mandalName: get('mandalName'),
      villageCode: get('villageCode'),
      villageName: get('villageName'),
      villageNameTe: get('villageNameTe') || null,
    };
    for (const code of [row.stateCode, row.districtCode, row.mandalCode, row.villageCode]) {
      if (!/^\d{1,10}$/.test(code)) throw new Error(`Row ${i + 2}: LGD codes must be numeric (got "${code}")`);
    }
    for (const name of [row.stateName, row.districtName, row.mandalName, row.villageName]) {
      if (name.length < 2) throw new Error(`Row ${i + 2}: a name is missing`);
    }
    return row;
  });
}

export interface ImportSummary {
  rows: number;
  created: Record<LocationLevel, number>;
  linked: Record<LocationLevel, number>;
  unchanged: number;
  version: string;
}

/** The file's "local language" column is Telugu in AP/Telangana and Hindi, Tamil, Bengali… elsewhere: check the script. */
const TELUGU_SCRIPT = /[\u0C00-\u0C7F]/;
const VILLAGE_BATCH = 5000;

/**
 * Imports one LGD file — a district, a state, or all ~6.5 lakh villages of India.
 *
 * States, districts and mandals (a few thousand) are matched one by one. Villages go in batches of 5,000: one query
 * finds which codes already exist, one query finds hand-typed villages to link, one insertMany adds the rest. Two
 * villages with the same name in the same mandal both exist in LGD; the second gets its code in its key.
 */
export async function importLgd(
  text: string,
  opts: { districtCode?: string; stateCode?: string; dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportSummary> {
  const rows = readLgdRows(text).filter((r) => (!opts.districtCode || r.districtCode === opts.districtCode) && (!opts.stateCode || r.stateCode === opts.stateCode));
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const summary: ImportSummary = {
    rows: rows.length,
    created: { state: 0, district: 0, mandal: 0, village: 0 },
    linked: { state: 0, district: 0, mandal: 0, village: 0 },
    unchanged: 0,
    version,
  };
  const cache = new Map<string, LocationDoc>();

  const upsert = async (level: LocationLevel, code: string, nameEn: string, parent: LocationDoc | null) => {
    const key = `${level}:${code}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let doc = await LocationModel.findOne({ level, lgdCode: code });
    if (doc) {
      summary.unchanged++;
    } else {
      // A place an admin typed in by hand: attach the official code rather than creating a duplicate.
      doc = await LocationModel.findOne({ level, parentId: parent?._id ?? null, nameKey: normaliseKey(nameEn), lgdCode: null });
      if (doc) {
        summary.linked[level]++;
        if (!opts.dryRun) {
          doc.lgdCode = code;
          await doc.save();
        }
      } else {
        summary.created[level]++;
        const name = { en: nameEn, te: null };
        doc = new LocationModel({
          _id: new Types.ObjectId(),
          level,
          parentId: parent?._id ?? null,
          ancestorIds: parent ? [...parent.ancestorIds, parent._id] : [],
          name,
          nameKey: normaliseKey(nameEn),
          lgdCode: code,
          aliases: [],
          searchKeys: buildSearchKeys(name, []),
          source: { dataset: 'lgd', createdBy: null, version },
        });
        if (!opts.dryRun) await doc.save();
      }
    }
    cache.set(key, doc);
    return doc;
  };

  // Parents first (each appears on many rows; the cache makes it one lookup each).
  const mandalOf = new Map<string, LocationDoc>();
  for (const r of rows) {
    if (mandalOf.has(r.mandalCode)) continue;
    const state = await upsert('state', r.stateCode, r.stateName, null);
    const district = await upsert('district', r.districtCode, r.districtName, state);
    mandalOf.set(r.mandalCode, await upsert('mandal', r.mandalCode, r.mandalName, district));
  }

  for (let i = 0; i < rows.length; i += VILLAGE_BATCH) {
    const batch = rows.slice(i, i + VILLAGE_BATCH);
    const existing = new Set(
      (await LocationModel.find({ level: 'village', lgdCode: { $in: batch.map((r) => r.villageCode) } }, { lgdCode: 1 }).lean()).map((d) => d.lgdCode),
    );
    const parentIds = [...new Set(batch.map((r) => mandalOf.get(r.mandalCode)!._id.toHexString()))].map((id) => new Types.ObjectId(id));
    const handTyped = new Map(
      (await LocationModel.find({ level: 'village', parentId: { $in: parentIds }, lgdCode: null }, { parentId: 1, nameKey: 1, name: 1, aliases: 1 }).lean()).map((d) => [`${d.parentId}:${d.nameKey}`, d]),
    );
    const fresh: Record<string, unknown>[] = [];
    const seenKey = new Set<string>();
    for (const r of batch) {
      if (existing.has(r.villageCode)) {
        summary.unchanged++;
        continue;
      }
      const mandal = mandalOf.get(r.mandalCode)!;
      const local = r.villageNameTe && r.villageNameTe !== r.villageName ? r.villageNameTe : null;
      const telugu = !!local && TELUGU_SCRIPT.test(local);
      const name = { en: r.villageName, te: telugu ? local : null };
      // Other states' local names (Hindi, Tamil…) are still searchable, as aliases.
      const aliases = !telugu && local ? [local] : [];
      const baseKey = normaliseKey(r.villageName);
      const linked = handTyped.get(`${mandal._id}:${baseKey}`);
      if (linked) {
        summary.linked.village++;
        handTyped.delete(`${mandal._id}:${baseKey}`);
        if (!opts.dryRun) {
          // Attach the official code; fill a missing Telugu name, never overwrite one an admin typed.
          const mergedName = { en: linked.name.en, te: linked.name.te || name.te };
          const mergedAliases = [...new Set([...(linked.aliases ?? []), ...aliases])];
          await LocationModel.updateOne(
            { _id: linked._id },
            { $set: { lgdCode: r.villageCode, 'name.te': mergedName.te, aliases: mergedAliases, searchKeys: buildSearchKeys(mergedName, mergedAliases) } },
          );
        }
        continue;
      }
      // Same name twice in one mandal (common in LGD): keep both, the second keyed by its code.
      const dupe = seenKey.has(`${mandal._id}:${baseKey}`);
      seenKey.add(`${mandal._id}:${baseKey}`);
      fresh.push({
        level: 'village',
        parentId: mandal._id,
        ancestorIds: [...mandal.ancestorIds, mandal._id],
        name,
        nameKey: dupe ? `${baseKey} #${r.villageCode}` : baseKey,
        lgdCode: r.villageCode,
        aliases,
        searchKeys: buildSearchKeys(name, aliases),
        validFrom: null,
        validTo: null,
        source: { dataset: 'lgd', createdBy: null, version },
      });
    }
    if (fresh.length && !opts.dryRun) {
      try {
        await LocationModel.insertMany(fresh, { ordered: false, rawResult: false });
      } catch (err) {
        // A name already used under that mandal by an earlier batch or run: retry those with the code in the key.
        const failed = ((err as { writeErrors?: { code?: number; index?: number; err?: { index?: number } }[] }).writeErrors ?? []).filter((e) => e.code === 11000 || e.err);
        if (!failed.length) throw err;
        const retry = failed.map((e) => fresh[e.index ?? e.err?.index ?? -1]).filter(Boolean).map((d) => ({ ...d, nameKey: `${d!.nameKey as string} #${d!.lgdCode as string}` }));
        await LocationModel.insertMany(retry, { ordered: false });
      }
    }
    summary.created.village += fresh.length;
    opts.onProgress?.(Math.min(i + VILLAGE_BATCH, rows.length), rows.length);
  }
  return summary;
}
