/**
 * Imports a state's districts, mandals and villages from OpenStreetMap (Overpass API).
 *
 *   npm run locations:import-osm -- --state "Andhra Pradesh" --te "ఆంధ్రప్రదేశ్"
 *   npm run locations:import-osm -- --state "Andhra Pradesh" --dry-run
 *   npm run locations:import-osm -- --state "Andhra Pradesh" --districts "Tirupati,Chittoor,Kadapa"   (only these)
 *
 * One query per district, one at a time with a pause (the public Overpass servers allow ~2 at once). Answers are
 * cached in data/osm/<state>/ so a re-run or an interrupted run does not ask again; delete the folder to refresh.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectDatabase, disconnectDatabase } from '../db';
import { AuditEventModel } from '../modules/audit/audit';
import {
  districtMandalsQuery,
  districtsQuery,
  importOsmPlaces,
  mandalPlacesQuery,
  OVERPASS_ENDPOINTS,
  parseDistrictPlaces,
  parseDistricts,
  parseMandals,
  parsePlaces,
  type OsmDistrict,
  type OsmMandal,
} from '../modules/geo/osm-import';

const USER_AGENT = 'LocalLens/1.0 (village list import, one query at a time)';
const PAUSE_MS = 3_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string): Promise<{ elements: never[] }> {
  let lastError = '';
  // The public servers are often full: keep trying for a while (about 25 minutes per district at most).
  for (let attempt = 0; attempt < 12; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length]!;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(360_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return JSON.parse(text) as { elements: never[] };
      lastError = `${endpoint}: HTTP ${res.status} ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`;
    } catch (err) {
      lastError = `${endpoint}: ${(err as Error).message}`;
    }
    console.warn(`  retrying (${lastError})`);
    await pause(Math.min(120_000, PAUSE_MS * (attempt + 2) * 5));
  }
  throw new Error(`Overpass failed: ${lastError}`);
}

async function cached(file: string, query: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as { elements: never[] };
  } catch {
    const json = await overpass(query);
    await writeFile(file, JSON.stringify(json));
    await pause(PAUSE_MS);
    return json;
  }
}

async function cli(): Promise<void> {
  const { values } = parseArgs({ options: { state: { type: 'string' }, te: { type: 'string' }, districts: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  const uri = process.env.MONGODB_URI;
  if (!values.state || !uri) {
    console.error('Usage: npm run locations:import-osm -- --state "Andhra Pradesh" [--te "ఆంధ్రప్రదేశ్"] [--dry-run]   (MONGODB_URI must be set)');
    process.exit(2);
  }
  const dir = new URL(`../../../../data/osm/${values.state.toLowerCase().replace(/[^a-z]+/g, '-')}/`, import.meta.url);
  await mkdir(dir, { recursive: true });

  const districts: OsmDistrict[] = [];
  const all = parseDistricts(await cached(fileURLToPath(new URL('districts.json', dir)), districtsQuery(values.state)));
  // --districts: a comma-separated list of names; "Kadapa" matches "YSR Kadapa".
  const wanted = values.districts?.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const list = wanted ? all.filter((d) => wanted.some((w) => d.name.toLowerCase().includes(w))) : all;
  if (wanted && list.length < wanted.length) console.warn(`Some names did not match. Districts: ${all.map((d) => d.name).join(', ')}`);
  console.log(`${list.length} of ${all.length} districts in ${values.state}: ${list.map((d) => d.name).join(', ')}`);
  for (const [i, d] of list.entries()) {
    // Whole-district answers saved by earlier runs are used as they are; otherwise ask mandal by mandal (small
    // queries get through even when the servers are busy).
    let mandals: OsmMandal[];
    try {
      mandals = parseDistrictPlaces(JSON.parse(await readFile(fileURLToPath(new URL(`district-${d.osmId}.json`, dir)), 'utf8')));
    } catch {
      const list = parseMandals(await cached(fileURLToPath(new URL(`district-${d.osmId}-mandals.json`, dir)), districtMandalsQuery(d.osmId)));
      mandals = [];
      for (const m of list) mandals.push({ ...m, villages: parsePlaces(await cached(fileURLToPath(new URL(`mandal-${m.osmId}.json`, dir)), mandalPlacesQuery(m.osmId))) });
    }
    districts.push({ ...d, mandals });
    console.log(`  ${i + 1}/${list.length} ${d.name}: ${mandals.length} mandals, ${mandals.reduce((n, m) => n + m.villages.length, 0)} places`);
  }

  await connectDatabase(uri);
  try {
    const dryRun = values['dry-run'] ?? false;
    const summary = await importOsmPlaces({ name: values.state, nameTe: values.te ?? null }, districts, { dryRun });
    console.log(dryRun ? 'DRY RUN — nothing was written.' : 'Import complete.');
    console.log(JSON.stringify(summary, null, 2));
    if (!dryRun) await AuditEventModel.create({ action: 'geo.osm_imported', metadata: { state: values.state, ...summary } });
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && /import-osm\.(ts|js)$/.test(process.argv[1])) {
  await cli();
}
