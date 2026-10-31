import { Types } from 'mongoose';
import type { LocationLevel } from '@locallens/contracts';
import { buildSearchKeys, LocationModel, normaliseKey, type LocationDoc } from './location.model';

/**
 * Imports districts, mandals and villages from OpenStreetMap — the same data our maps show — for one state.
 *
 * Why: the official LGD village list needs a manual download (CAPTCHA), while OpenStreetMap can be queried directly
 * and adds Telugu names and map positions. Licence: ODbL — "© OpenStreetMap contributors" is credited on our maps.
 *
 * Shape of the data (Overpass API): each district is a boundary relation (admin_level 5) and each mandal one at
 * admin_level 6; villages, towns and hamlets are points (place=*) inside a mandal's boundary. One query per district
 * returns every mandal followed by the places inside it.
 *
 * Rules (same spirit as the LGD import):
 *  - Matching is by name under the same parent, so places added by hand or from LGD are filled in, not duplicated.
 *  - Re-running changes nothing (idempotent). Telugu names and map positions already set are never overwritten.
 *  - A mandal that two district boundaries both cover (OSM lagging behind a district split) goes to the newer
 *    district; a village on a mandal border goes to the first mandal it was found in.
 */

export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const PLACE_TYPES = 'village|town|city|hamlet|suburb';
/** OSM boundary relations at admin_level 6 that are not mandals (development authorities, corporations…). */
const NOT_A_MANDAL = /authority|corporation|municipal|region|cantonment/i;
const TELUGU_SCRIPT = /[ఀ-౿]/;

export interface OsmPlace {
  osmId: number;
  name: string;
  nameTe: string | null;
  lat: number | null;
  lon: number | null;
}
export interface OsmMandal extends OsmPlace {
  villages: OsmPlace[];
}
export interface OsmDistrict extends OsmPlace {
  mandals: OsmMandal[];
}

export const districtsQuery = (state: string) =>
  `[out:json][timeout:120];area["name"="${state.replace(/"/g, '')}"]["admin_level"="4"]->.s;rel(area.s)["boundary"="administrative"]["admin_level"="5"];out tags center;`;

export const districtPlacesQuery = (districtRelationId: number) =>
  `[out:json][timeout:300];area(id:${3_600_000_000 + districtRelationId})->.d;` +
  `rel(area.d)["boundary"="administrative"]["admin_level"="6"]->.ms;` +
  `foreach.ms->.m(.m out tags center;.m map_to_area->.a;node(area.a)["place"~"^(${PLACE_TYPES})$"]["name"];out;);`;

/**
 * The same data in small pieces, for when the public servers are busy (they turn away big queries first): the list of
 * a district's mandals, then one query per mandal.
 */
export const districtMandalsQuery = (districtRelationId: number) =>
  `[out:json][timeout:90][maxsize:33554432];area(id:${3_600_000_000 + districtRelationId})->.d;rel(area.d)["boundary"="administrative"]["admin_level"="6"];out tags center;`;
export const mandalPlacesQuery = (mandalRelationId: number) =>
  `[out:json][timeout:90][maxsize:33554432];area(id:${3_600_000_000 + mandalRelationId})->.a;node(area.a)["place"~"^(${PLACE_TYPES})$"]["name"];out;`;

interface OverpassElement {
  type: 'node' | 'relation' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** "Guntur District" → "Guntur", "YSR  Kadapa District" → "YSR Kadapa", "Tenali Mandal" → "Tenali". */
export function cleanName(name: string): string {
  return name
    .replace(/\s+(district|mandal|mandalam|tehsil|taluk)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPlace(e: OverpassElement): OsmPlace | null {
  const tags = e.tags ?? {};
  const en = cleanName(tags['name:en'] || tags.name || '');
  if (en.length < 2) return null;
  const te = tags['name:te'] || (TELUGU_SCRIPT.test(tags.name ?? '') ? tags.name! : null);
  const pos = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
  return { osmId: e.id, name: TELUGU_SCRIPT.test(en) ? cleanName(tags['name:en'] || en) : en, nameTe: te ? cleanName(te) : null, lat: pos?.lat ?? null, lon: pos?.lon ?? null };
}

export function parseDistricts(json: { elements: OverpassElement[] }): OsmPlace[] {
  return json.elements.filter((e) => e.type === 'relation').flatMap((e) => toPlace(e) ?? []);
}

export function parseMandals(json: { elements: OverpassElement[] }): OsmPlace[] {
  return json.elements.filter((e) => e.type === 'relation' && !NOT_A_MANDAL.test(e.tags?.name ?? '')).flatMap((e) => toPlace(e) ?? []);
}

export function parsePlaces(json: { elements: OverpassElement[] }): OsmPlace[] {
  return json.elements.filter((e) => e.type === 'node').flatMap((e) => toPlace(e) ?? []);
}

/** The district query's answer is a flat list: each mandal relation, then the places inside it. */
export function parseDistrictPlaces(json: { elements: OverpassElement[] }): OsmMandal[] {
  const mandals: OsmMandal[] = [];
  let current: OsmMandal | null = null;
  for (const e of json.elements) {
    if (e.type === 'relation') {
      const place = toPlace(e);
      current = place && !NOT_A_MANDAL.test(e.tags?.name ?? '') ? { ...place, villages: [] } : null;
      if (current) mandals.push(current);
    } else if (e.type === 'node' && current) {
      const place = toPlace(e);
      if (place) current.villages.push(place);
    }
  }
  return mandals;
}

export interface OsmImportSummary {
  districts: number;
  mandals: number;
  villages: number;
  created: Record<LocationLevel, number>;
  filledIn: number;
  skippedDuplicates: number;
}

const geoOf = (p: OsmPlace) => (p.lat !== null && p.lon !== null ? { lat: p.lat, lon: p.lon, source: 'openstreetmap' as const, at: new Date() } : null);

export async function importOsmPlaces(state: { name: string; nameTe: string | null }, districts: OsmDistrict[], opts: { dryRun?: boolean } = {}): Promise<OsmImportSummary> {
  const summary: OsmImportSummary = { districts: 0, mandals: 0, villages: 0, created: { state: 0, district: 0, mandal: 0, village: 0 }, filledIn: 0, skippedDuplicates: 0 };

  const upsert = async (level: LocationLevel, raw: OsmPlace, parent: LocationDoc | null): Promise<LocationDoc> => {
    const place = { ...raw, name: cleanName(raw.name) };
    const nameKey = normaliseKey(place.name);
    const doc = await LocationModel.findOne({ parentId: parent?._id ?? null, nameKey, validTo: null });
    if (doc) {
      // Fill what is missing; never overwrite what an admin or the LGD import set.
      const fill: Record<string, unknown> = {};
      if (!doc.name.te && place.nameTe) fill['name.te'] = place.nameTe;
      if (!doc.geo && geoOf(place)) fill.geo = geoOf(place);
      if (Object.keys(fill).length) summary.filledIn++;
      const keys = buildSearchKeys({ en: doc.name.en, te: doc.name.te || place.nameTe }, doc.aliases);
      if (keys.join('|') !== doc.searchKeys.join('|')) fill.searchKeys = keys;
      if (Object.keys(fill).length && !opts.dryRun) await LocationModel.updateOne({ _id: doc._id }, { $set: fill });
      return doc;
    }
    summary.created[level]++;
    const name = { en: place.name, te: place.nameTe };
    const created = new LocationModel({
      _id: new Types.ObjectId(),
      level,
      parentId: parent?._id ?? null,
      ancestorIds: parent ? [...parent.ancestorIds, parent._id] : [],
      name,
      nameKey,
      aliases: [],
      searchKeys: buildSearchKeys(name, []),
      source: { dataset: 'openstreetmap', createdBy: null, version: `osm:${level === 'village' ? 'node' : 'relation'}/${place.osmId}` },
      geo: geoOf(place),
      geoTriedAt: geoOf(place) ? new Date() : null,
    });
    if (!opts.dryRun) await created.save();
    return created;
  };

  const stateDoc = await upsert('state', { osmId: 0, name: state.name, nameTe: state.nameTe, lat: null, lon: null }, null);
  const seenMandals = new Set<number>();
  const seenVillages = new Set<number>();
  // Newer districts (higher relation ids, e.g. after a split) claim their mandals first.
  for (const district of [...districts].sort((a, b) => b.osmId - a.osmId)) {
    const districtDoc = await upsert('district', district, stateDoc);
    summary.districts++;
    for (const mandal of district.mandals) {
      if (seenMandals.has(mandal.osmId)) continue;
      seenMandals.add(mandal.osmId);
      const mandalDoc = await upsert('mandal', mandal, districtDoc);
      summary.mandals++;

      // Villages: one lookup for the mandal's existing children, one insertMany for the rest.
      const existing = new Map(
        (await LocationModel.find({ parentId: mandalDoc._id }, { nameKey: 1, name: 1, geo: 1, aliases: 1, searchKeys: 1 }).lean()).map((d) => [d.nameKey, d]),
      );
      const fresh: Record<string, unknown>[] = [];
      const addedNow = new Set<string>();
      for (const v of mandal.villages) {
        if (seenVillages.has(v.osmId)) continue;
        seenVillages.add(v.osmId);
        summary.villages++;
        const nameKey = normaliseKey(v.name);
        // Two OSM points with one name in one mandal (a village and its hamlet, usually): keep the first.
        if (addedNow.has(nameKey)) {
          summary.skippedDuplicates++;
          continue;
        }
        const known = existing.get(nameKey);
        if (known) {
          addedNow.add(nameKey);
          const fill: Record<string, unknown> = {};
          if (!known.name.te && v.nameTe) fill['name.te'] = v.nameTe;
          if (!known.geo && geoOf(v)) fill.geo = geoOf(v);
          if (Object.keys(fill).length) summary.filledIn++;
          else summary.skippedDuplicates++;
          const keys = buildSearchKeys({ en: known.name.en, te: known.name.te || v.nameTe }, known.aliases ?? []);
          if (keys.join('|') !== (known.searchKeys ?? []).join('|')) fill.searchKeys = keys;
          if (Object.keys(fill).length && !opts.dryRun) await LocationModel.updateOne({ _id: known._id }, { $set: fill });
          continue;
        }
        const name = { en: v.name, te: v.nameTe };
        const doc = {
          _id: new Types.ObjectId(),
          level: 'village',
          parentId: mandalDoc._id,
          ancestorIds: [...mandalDoc.ancestorIds, mandalDoc._id],
          name,
          nameKey,
          lgdCode: null,
          aliases: [],
          searchKeys: buildSearchKeys(name, []),
          validFrom: null,
          validTo: null,
          source: { dataset: 'openstreetmap', createdBy: null, version: `osm:node/${v.osmId}` },
          geo: geoOf(v),
          geoTriedAt: geoOf(v) ? new Date() : null,
        };
        addedNow.add(nameKey);
        fresh.push(doc);
      }
      if (fresh.length && !opts.dryRun) await LocationModel.insertMany(fresh, { ordered: false });
      summary.created.village += fresh.length;
    }
  }
  return summary;
}
