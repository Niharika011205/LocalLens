import { z } from 'zod';
import { ObjectIdString } from './common';

export const LOCATION_LEVELS = ['state', 'district', 'mandal', 'village'] as const;
export const LocationLevel = z.enum(LOCATION_LEVELS);
export type LocationLevel = z.infer<typeof LocationLevel>;

/** The level a child of `parent` must have; states have no parent. */
export function childLevel(parent: LocationLevel | null): LocationLevel | null {
  if (parent === null) return 'state';
  const i = LOCATION_LEVELS.indexOf(parent);
  return LOCATION_LEVELS[i + 1] ?? null;
}

export const LocalizedName = z.object({ en: z.string(), te: z.string().nullable() });
export type LocalizedName = z.infer<typeof LocalizedName>;

export const LocationSummary = z.object({
  id: z.string(),
  level: LocationLevel,
  parentId: z.string().nullable(),
  name: LocalizedName,
  lgdCode: z.string().nullable(),
  /** e.g. "Kollipara, Tenali, Guntur" — the place and its ancestors below state level, in English. */
  label: z.string(),
  labelTe: z.string().nullable(),
});
export type LocationSummary = z.infer<typeof LocationSummary>;

export const LocationDetail = LocationSummary.extend({
  ancestors: z.array(LocationSummary),
  aliases: z.array(z.string()),
});
export type LocationDetail = z.infer<typeof LocationDetail>;

export const LocationMapResponse = z.object({
  /** Where to centre the map (OpenStreetMap), or null when the place could not be found on the map. */
  map: z.object({ lat: z.number(), lon: z.number(), zoom: z.number(), source: z.literal('openstreetmap') }).nullable(),
  /** "Open in Google Maps" (a plain link; nothing is fetched from Google). */
  googleMapsUrl: z.string(),
});
export type LocationMapResponse = z.infer<typeof LocationMapResponse>;

export const LocationListResponse = z.object({ items: z.array(LocationSummary) });
export type LocationListResponse = z.infer<typeof LocationListResponse>;

export const LocationResponse = z.object({ location: LocationDetail });
export type LocationResponse = z.infer<typeof LocationResponse>;

export const ListLocationsQuery = z.object({
  // Omit for top level (states).
  parentId: ObjectIdString.optional(),
});

export const SearchLocationsQuery = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

const NameEn = z.string().trim().min(2).max(80);
const NameTe = z.string().trim().min(1).max(80);
const LgdCode = z.string().trim().regex(/^\d{1,10}$/, 'LGD codes are numeric');
const Aliases = z.array(z.string().trim().min(2).max(80)).max(10);

export const CreateLocationRequest = z
  .object({
    parentId: ObjectIdString.nullable(),
    level: LocationLevel,
    nameEn: NameEn,
    nameTe: NameTe.optional(),
    lgdCode: LgdCode.optional(),
    aliases: Aliases.optional(),
  })
  .strict();
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;

export const UpdateLocationRequest = z
  .object({
    nameEn: NameEn.optional(),
    nameTe: NameTe.nullable().optional(),
    lgdCode: LgdCode.nullable().optional(),
    aliases: Aliases.optional(),
  })
  .strict();
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequest>;
