import { afterEach, describe, expect, it } from 'vitest';
import { configureGeocoder, type GeocodeFetch } from '../src/modules/geo/geocode';
import { LocationModel } from '../src/modules/geo/location.model';
import { createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

function fakeNominatim(answer: (q: string) => { lat: string; lon: string }[]) {
  const calls: { url: string; at: number; ua: string }[] = [];
  const fetcher: GeocodeFetch = async (url, init) => {
    calls.push({ url, at: Date.now(), ua: init.headers['User-Agent']! });
    return { ok: true, json: async () => answer(decodeURIComponent(new URL(url).searchParams.get('q') ?? '')) };
  };
  return { fetcher, calls };
}

afterEach(() => configureGeocoder({ enabled: false, appOrigin: 'http://localhost' }));

describe('place maps', () => {
  it('looks a place up once on OpenStreetMap (with its mandal, district and state), then serves it from the database', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const nominatim = fakeNominatim(() => [{ lat: '16.30', lon: '80.45' }]);
    configureGeocoder({ enabled: true, appOrigin: 'https://locallens.example', fetcher: nominatim.fetcher });

    const first = (await client(app).get(`/api/v1/locations/${tree.village.id}/map`).expect(200)).body;
    expect(first).toEqual({
      map: { lat: 16.3, lon: 80.45, zoom: 14, source: 'openstreetmap' },
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=16.3%2C80.45',
    });
    expect(nominatim.calls).toHaveLength(1);
    expect(decodeURIComponent(nominatim.calls[0]!.url)).toContain('q=Alpha Village, Alpha Mandal, Test District, Test State, India');
    expect(nominatim.calls[0]!.url).toContain('countrycodes=in');
    expect(nominatim.calls[0]!.ua).toBe('LocalLens/1.0 (+https://locallens.example)'); // identifies us, as the policy asks

    await client(app).get(`/api/v1/locations/${tree.village.id}/map`).expect(200);
    expect(nominatim.calls).toHaveLength(1); // cached
    expect((await LocationModel.findById(tree.village.id).lean())?.geo).toMatchObject({ lat: 16.3, lon: 80.45, source: 'openstreetmap' });
  });

  it('never sends more than one request a second, and rejects answers outside India', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const nominatim = fakeNominatim((q) => (q.startsWith('Beta') ? [{ lat: '51.5', lon: '-0.12' }] : [{ lat: '16.3', lon: '80.4' }]));
    configureGeocoder({ enabled: true, appOrigin: 'http://localhost', fetcher: nominatim.fetcher });

    const [a, b] = await Promise.all([
      client(app).get(`/api/v1/locations/${tree.mandalA.id}/map`).expect(200),
      client(app).get(`/api/v1/locations/${tree.mandalB.id}/map`).expect(200),
    ]);
    expect(Math.abs(nominatim.calls[1]!.at - nominatim.calls[0]!.at)).toBeGreaterThanOrEqual(1000);
    expect(a.body.map).toMatchObject({ zoom: 11 });
    expect(b.body.map).toBeNull(); // "Beta Mandal" resolved to London: not trusted
    expect(b.body.googleMapsUrl).toContain(encodeURIComponent('Beta Mandal'));
    // A miss is not retried on every view.
    await client(app).get(`/api/v1/locations/${tree.mandalB.id}/map`).expect(200);
    expect(nominatim.calls).toHaveLength(2);
  });

  it('with maps off, still offers a Google Maps link by name', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const res = (await client(app).get(`/api/v1/locations/${tree.district.id}/map`).expect(200)).body;
    expect(res.map).toBeNull();
    expect(res.googleMapsUrl).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Test District, India')}`);
  });
});
