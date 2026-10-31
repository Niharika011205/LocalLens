import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { LOCATION_LEVELS, type LocationLevel } from '@locallens/contracts';

export interface Location {
  level: LocationLevel;
  parentId: Types.ObjectId | null;
  /** Ordered root → parent. "Everything inside X" is { ancestorIds: X }, one multikey index lookup. */
  ancestorIds: Types.ObjectId[];
  name: { en: string; te: string | null };
  /** Lowercased English name; unique among siblings so the same village is not added twice. */
  nameKey: string;
  lgdCode: string | null;
  aliases: string[];
  /** Normalised names and aliases used for prefix search. */
  searchKeys: string[];
  /** Effective dating: when a unit is split or renamed it is closed, never deleted, so old articles still resolve. */
  validFrom: Date | null;
  validTo: Date | null;
  source: { dataset: 'manual' | 'lgd' | 'openstreetmap'; createdBy: Types.ObjectId | null; version: string | null };
  /** Map position (OpenStreetMap), looked up once on first view. */
  geo: { lat: number; lon: number; source: 'openstreetmap'; at: Date } | null;
  geoTriedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type LocationDoc = HydratedDocument<Location>;

const locationSchema = new Schema<Location>(
  {
    level: { type: String, enum: LOCATION_LEVELS, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    ancestorIds: { type: [Schema.Types.ObjectId], default: [] },
    name: {
      en: { type: String, required: true, trim: true },
      te: { type: String, default: null, trim: true },
    },
    nameKey: { type: String, required: true },
    lgdCode: { type: String, default: null },
    aliases: { type: [String], default: [] },
    searchKeys: { type: [String], default: [] },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    source: {
      dataset: { type: String, enum: ['manual', 'lgd', 'openstreetmap'], required: true },
      createdBy: { type: Schema.Types.ObjectId, default: null },
      version: { type: String, default: null },
    },
    geo: { type: { lat: Number, lon: Number, source: String, at: Date }, default: null, _id: false },
    geoTriedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
locationSchema.index({ parentId: 1, nameKey: 1 }, { unique: true });
locationSchema.index({ ancestorIds: 1 });
locationSchema.index({ searchKeys: 1 });
locationSchema.index(
  { level: 1, lgdCode: 1 },
  { unique: true, partialFilterExpression: { lgdCode: { $type: 'string' } } },
);

export const LocationModel = model<Location>('Location', locationSchema, 'locations');

/** Lowercase, NFC-normalised, punctuation collapsed — the same rule for stored keys and search input. */
export function normaliseKey(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.,'’()-]+/g, ' ')
    .trim();
}

/**
 * Each name, plus the name from each later word on, so a prefix search finds "Pedda Vadlapudi" from "vadlapudi" and
 * "YSR Kadapa" from "kadapa" while still using the index.
 */
export function buildSearchKeys(name: { en: string; te: string | null }, aliases: string[]): string[] {
  const keys = [name.en, name.te, ...aliases].filter((v): v is string => !!v).map(normaliseKey);
  const fromEachWord = keys.flatMap((k) => k.split(' ').map((_, i, words) => words.slice(i).join(' ')).filter((s) => s.length >= 2));
  return [...new Set([...keys, ...fromEachWord])];
}
