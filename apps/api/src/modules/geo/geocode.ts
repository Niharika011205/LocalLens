import type { Logger } from 'pino';
import type { LocationMapResponse } from '@locallens/contracts';
import { LocationModel, type LocationDoc } from './location.model';

/**
 * Where a place is on the map, from OpenStreetMap's Nominatim — free, and allowed to be stored (unlike Google's
 * Places data). Usage policy we follow: at most one request a second from this server, an identifying User-Agent, and
 * results cached forever (each place is looked up once; a miss is not retried for 30 days).
 * https://operations.osmfoundation.org/policies/nominatim/
 */

const INDIA = { minLat: 6, maxLat: 37.5, minLon: 68, maxLon: 97.5 };
const RETRY_MISS_MS = 30 * 86_400_000;
const ZOOM = { state: 6, district: 9, mandal: 11, village: 14 } as const;

export type GeocodeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

let settings: { enabled: boolean; baseUrl: string; userAgent: string; fetcher: GeocodeFetch; logger?: Logger } = {
  enabled: false,
  baseUrl: 'https://nominatim.openstreetmap.org',
  userAgent: 'LocalLens/1.0',
  fetcher: fetch as unknown as GeocodeFetch,
};
export function configureGeocoder(opts: { enabled: boolean; baseUrl?: string; appOrigin: string; fetcher?: GeocodeFetch; logger?: Logger }): void {
  settings = {
    enabled: opts.enabled,
    baseUrl: (opts.baseUrl ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    userAgent: `LocalLens/1.0 (+${opts.appOrigin})`,
    fetcher: opts.fetcher ?? (fetch as unknown as GeocodeFetch),
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
}

// One request a second, process-wide.
let queue: Promise<unknown> = Promise.resolve();
let last = 0;
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function lookup(loc: LocationDoc): Promise<{ lat: number; lon: number } | null> {
  const chain = await LocationModel.find({ _id: { $in: loc.ancestorIds } }, { name: 1, level: 1 }).lean();
  const order = ['village', 'mandal', 'district', 'state'];
  const parts = [loc, ...chain].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((p) => p.name.en);
  const q = [...parts, 'India'].join(', ');
  const url = `${settings.baseUrl}/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
  const res = await politely(() => settings.fetcher(url, { headers: { 'User-Agent': settings.userAgent, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) }));
  if (!res.ok) throw new Error('geocoder unavailable');
  const [hit] = (await res.json()) as { lat?: string; lon?: string }[];
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < INDIA.minLat || lat > INDIA.maxLat || lon < INDIA.minLon || lon > INDIA.maxLon) return null;
  return { lat, lon };
}

function googleMapsUrl(loc: LocationDoc, geo: { lat: number; lon: number } | null, label: string): string {
  // A plain link to Google Maps (allowed); nothing from Google is fetched or stored.
  const query = geo ? `${geo.lat},${geo.lon}` : `${label}, India`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export async function placeMap(loc: LocationDoc, label: string): Promise<LocationMapResponse> {
  let geo = loc.geo?.lat !== undefined && loc.geo?.lat !== null ? { lat: loc.geo.lat, lon: loc.geo.lon } : null;
  const recentlyMissed = loc.geoTriedAt && Date.now() - loc.geoTriedAt.getTime() < RETRY_MISS_MS;
  if (!geo && settings.enabled && !recentlyMissed) {
    try {
      geo = await lookup(loc);
      await LocationModel.updateOne({ _id: loc._id }, { $set: { geoTriedAt: new Date(), ...(geo ? { geo: { ...geo, source: 'openstreetmap', at: new Date() } } : {}) } });
    } catch (err) {
      settings.logger?.warn({ err: (err as Error).message, location: loc.id }, 'geocoding failed');
    }
  }
  return {
    map: geo ? { lat: geo.lat, lon: geo.lon, zoom: ZOOM[loc.level], source: 'openstreetmap' } : null,
    googleMapsUrl: googleMapsUrl(loc, geo, label),
  };
}
