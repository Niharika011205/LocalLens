import { Types } from 'mongoose';
import {
  childLevel,
  type CreateLocationRequest,
  type LocationDetail,
  type LocationSummary,
  type UpdateLocationRequest,
} from '@locallens/contracts';
import { AppError, Errors } from '../../lib/errors';
import { buildSearchKeys, LocationModel, normaliseKey, type LocationDoc } from './location.model';

const DUPLICATE_KEY = 11000;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds summaries with human-readable labels ("Kollipara, Tenali, Guntur") for many locations using one extra
 * query for all their ancestors. State names are left out of labels except for the state itself.
 */
export async function toSummaries(docs: LocationDoc[]): Promise<LocationSummary[]> {
  const ancestorIds = [...new Set(docs.flatMap((d) => d.ancestorIds.map(String)))];
  const ancestors = ancestorIds.length ? await LocationModel.find({ _id: { $in: ancestorIds } }) : [];
  const byId = new Map(ancestors.map((a) => [a.id as string, a]));
  return docs.map((d) => {
    const chain = [d, ...[...d.ancestorIds].reverse().map((id) => byId.get(String(id))).filter((a): a is LocationDoc => !!a)];
    const named = d.level === 'state' ? chain : chain.filter((l) => l.level !== 'state');
    const te = named.every((l) => l.name.te) ? named.map((l) => l.name.te).join(', ') : null;
    return {
      id: d.id as string,
      level: d.level,
      parentId: d.parentId ? String(d.parentId) : null,
      name: { en: d.name.en, te: d.name.te ?? null },
      lgdCode: d.lgdCode ?? null,
      label: named.map((l) => l.name.en).join(', '),
      labelTe: te,
    };
  });
}

export async function toSummary(doc: LocationDoc): Promise<LocationSummary> {
  return (await toSummaries([doc]))[0]!;
}

export async function getLocationOrThrow(id: string | Types.ObjectId): Promise<LocationDoc> {
  const loc = await LocationModel.findById(id);
  if (!loc) throw Errors.notFound('Location not found');
  return loc;
}

export async function locationDetail(doc: LocationDoc): Promise<LocationDetail> {
  const ancestorDocs = doc.ancestorIds.length ? await LocationModel.find({ _id: { $in: doc.ancestorIds } }) : [];
  const ordered = doc.ancestorIds
    .map((id) => ancestorDocs.find((a) => a._id.equals(id)))
    .filter((a): a is LocationDoc => !!a);
  const [self, ...ancestors] = await toSummaries([doc, ...ordered]);
  return { ...self!, ancestors, aliases: [...doc.aliases] };
}

export async function listChildren(parentId: string | undefined): Promise<LocationSummary[]> {
  const docs = await LocationModel.find({ parentId: parentId ? new Types.ObjectId(parentId) : null, validTo: null }).sort({
    'name.en': 1,
  });
  return toSummaries(docs);
}

/** Prefix search over English names, Telugu names and aliases. */
export async function searchLocations(q: string, limit: number): Promise<LocationSummary[]> {
  const key = normaliseKey(q);
  if (!key) return [];
  // Fetch a few more than asked, then rank: the exact name first ("Kuppam" before "Beera Kuppam"), then names that
  // start with the text, then matches on a later word; bigger places first within each group.
  const [exact, prefixed] = await Promise.all([
    LocationModel.find({ searchKeys: key, validTo: null }).limit(limit),
    LocationModel.find({ searchKeys: { $regex: `^${escapeRegex(key)}` }, validTo: null })
      .sort({ level: 1, 'name.en': 1 })
      .limit(Math.min(limit * 4, 120)),
  ]);
  const docs = [...new Map([...exact, ...prefixed].map((d) => [d.id as string, d])).values()];
  const rank = (d: LocationDoc) => {
    const names = [d.name.en, d.name.te, ...d.aliases].filter((n): n is string => !!n).map(normaliseKey);
    return names.includes(key) ? 0 : names.some((n) => n.startsWith(key)) ? 1 : 2;
  };
  const LEVEL_ORDER = { state: 0, district: 1, mandal: 2, village: 3 } as const;
  const ranked = docs
    .map((d) => ({ d, r: rank(d) }))
    .sort((a, b) => a.r - b.r || LEVEL_ORDER[a.d.level] - LEVEL_ORDER[b.d.level] || a.d.name.en.localeCompare(b.d.name.en))
    .slice(0, limit)
    .map((x) => x.d);
  return toSummaries(ranked);
}

export async function createLocation(input: CreateLocationRequest, actorId: Types.ObjectId): Promise<LocationDoc> {
  const parent = input.parentId ? await getLocationOrThrow(input.parentId) : null;
  const expected = childLevel(parent ? parent.level : null);
  if (expected !== input.level) {
    throw new AppError(400, 'VALIDATION_FAILED', `A ${parent ? parent.level : 'top-level location'} can only contain a ${expected ?? 'nothing'}`, [
      { path: 'level', message: `Expected ${expected ?? 'none'}` },
    ]);
  }
  const name = { en: input.nameEn, te: input.nameTe ?? null };
  const aliases = input.aliases ?? [];
  try {
    return await LocationModel.create({
      level: input.level,
      parentId: parent?._id ?? null,
      ancestorIds: parent ? [...parent.ancestorIds, parent._id] : [],
      name,
      nameKey: normaliseKey(input.nameEn),
      lgdCode: input.lgdCode ?? null,
      aliases,
      searchKeys: buildSearchKeys(name, aliases),
      source: { dataset: 'manual', createdBy: actorId, version: null },
    });
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY) {
      throw Errors.conflict('A location with this name (or LGD code) already exists here');
    }
    throw err;
  }
}

export async function updateLocation(id: string, input: UpdateLocationRequest): Promise<LocationDoc> {
  const loc = await getLocationOrThrow(id);
  if (input.nameEn !== undefined) {
    loc.name.en = input.nameEn;
    loc.nameKey = normaliseKey(input.nameEn);
  }
  if (input.nameTe !== undefined) loc.name.te = input.nameTe;
  if (input.lgdCode !== undefined) loc.lgdCode = input.lgdCode;
  if (input.aliases !== undefined) loc.aliases = input.aliases;
  loc.searchKeys = buildSearchKeys(loc.name, loc.aliases);
  try {
    return await loc.save();
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY) {
      throw Errors.conflict('A location with this name (or LGD code) already exists here');
    }
    throw err;
  }
}
