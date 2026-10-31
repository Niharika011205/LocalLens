import { describe, expect, it } from 'vitest';
import { cleanName, importOsmPlaces, parseDistrictPlaces, type OsmDistrict } from '../src/modules/geo/osm-import';
import { LocationModel } from '../src/modules/geo/location.model';
import { useTestDb } from './helpers';

useTestDb();

/** Shaped like an Overpass answer to districtPlacesQuery: each mandal relation, then the places inside it. Names made up. */
const overpassAnswer = {
  elements: [
    { type: 'relation', id: 101, center: { lat: 16.3, lon: 80.4 }, tags: { name: 'Testapuram Mandal', 'name:te': 'టెస్టాపురం', admin_level: '6' } },
    { type: 'node', id: 1, lat: 16.31, lon: 80.41, tags: { place: 'village', name: 'Rampalle', 'name:te': 'రాంపల్లె' } },
    { type: 'node', id: 2, lat: 16.32, lon: 80.42, tags: { place: 'village', name: 'Kothapalem' } },
    { type: 'node', id: 3, lat: 16.33, lon: 80.43, tags: { place: 'hamlet', name: 'Kothapalem' } }, // same name: kept once
    { type: 'relation', id: 102, tags: { name: 'Test Capital Region Development Authority', admin_level: '6' } }, // not a mandal
    { type: 'node', id: 9, lat: 16.4, lon: 80.5, tags: { place: 'village', name: 'Ignored' } },
    { type: 'relation', id: 103, center: { lat: 16.5, lon: 80.6 }, tags: { name: 'Second Mandal' } },
    { type: 'node', id: 1, lat: 16.31, lon: 80.41, tags: { place: 'village', name: 'Rampalle' } }, // on the border: first mandal wins
    { type: 'node', id: 4, lat: 16.51, lon: 80.61, tags: { place: 'town', name: 'Pattanam', 'name:te': 'పట్టణం' } },
  ],
};

describe('OpenStreetMap village import', () => {
  it('reads mandals and the places inside each, skipping boundaries that are not mandals', () => {
    const mandals = parseDistrictPlaces(overpassAnswer as never);
    expect(mandals.map((m) => [m.name, m.villages.length])).toEqual([
      ['Testapuram', 3],
      ['Second', 2],
    ]);
    expect(cleanName('YSR  Kadapa District')).toBe('YSR Kadapa');
  });

  it('builds state → district → mandal → village with Telugu names and map positions; re-running changes nothing', async () => {
    const district: OsmDistrict = { osmId: 500, name: 'Testgiri', nameTe: 'టెస్టగిరి', lat: 16, lon: 80, mandals: parseDistrictPlaces(overpassAnswer as never) };
    const first = await importOsmPlaces({ name: 'Test Pradesh', nameTe: null }, [district]);
    expect(first.created).toEqual({ state: 1, district: 1, mandal: 2, village: 3 });
    expect(first.skippedDuplicates).toBe(1);

    const village = await LocationModel.findOne({ nameKey: 'rampalle' }).lean();
    expect(village).toMatchObject({ level: 'village', name: { en: 'Rampalle', te: 'రాంపల్లె' }, geo: { lat: 16.31, lon: 80.41, source: 'openstreetmap' } });
    expect(village!.ancestorIds).toHaveLength(3);
    expect(village!.searchKeys).toContain('రాంపల్లె');
    expect((await LocationModel.findById(village!.parentId).lean())!.name.en).toBe('Testapuram');

    const again = await importOsmPlaces({ name: 'Test Pradesh', nameTe: null }, [district]);
    expect(again.created).toEqual({ state: 0, district: 0, mandal: 0, village: 0 });
    expect(await LocationModel.countDocuments()).toBe(7);
  });

  it('fills in places that already exist (typed by an admin) instead of duplicating them, never overwriting', async () => {
    const state = await LocationModel.create({ level: 'state', parentId: null, ancestorIds: [], name: { en: 'Test Pradesh', te: 'అధికారిక పేరు' }, nameKey: 'test pradesh', searchKeys: [], source: { dataset: 'manual', createdBy: null, version: null } });
    const district = await LocationModel.create({ level: 'district', parentId: state._id, ancestorIds: [state._id], name: { en: 'Testgiri', te: null }, nameKey: 'testgiri', searchKeys: [], source: { dataset: 'manual', createdBy: null, version: null } });
    await importOsmPlaces({ name: 'Test Pradesh', nameTe: 'వేరే పేరు' }, [{ osmId: 500, name: 'Testgiri District', nameTe: 'టెస్టగిరి', lat: 16, lon: 80, mandals: [] }]);
    expect(await LocationModel.countDocuments({ level: { $in: ['state', 'district'] } })).toBe(2);
    expect((await LocationModel.findById(state._id).lean())!.name.te).toBe('అధికారిక పేరు');
    expect((await LocationModel.findById(district._id).lean())).toMatchObject({ name: { te: 'టెస్టగిరి' }, geo: { lat: 16, lon: 80 } });
  });

  it('a mandal inside two district boundaries (after a district split) goes to the newer district only', async () => {
    const mandals = parseDistrictPlaces(overpassAnswer as never);
    await importOsmPlaces({ name: 'Test Pradesh', nameTe: null }, [
      { osmId: 500, name: 'Oldpet District', nameTe: null, lat: null, lon: null, mandals },
      { osmId: 900, name: 'Newpet District', nameTe: null, lat: null, lon: null, mandals: mandals.slice(0, 1) },
    ]);
    const mandal = await LocationModel.findOne({ level: 'mandal', nameKey: 'testapuram' }).lean();
    expect((await LocationModel.findById(mandal!.parentId).lean())!.name.en).toBe('Newpet');
    expect(await LocationModel.countDocuments({ level: 'mandal' })).toBe(2);
  });
});

describe('place search by any word', () => {
  it('finds two-word names from the second word, in English and Telugu', async () => {
    const { buildSearchKeys } = await import('../src/modules/geo/location.model');
    const { searchLocations } = await import('../src/modules/geo/geo.service');
    const mandals = parseDistrictPlaces({
      elements: [
        { type: 'relation', id: 1, tags: { name: 'Tenali Mandal' } },
        { type: 'node', id: 2, lat: 16, lon: 80, tags: { place: 'village', name: 'Pedda Vadlapudi', 'name:te': 'పెద్ద వడ్లపూడి' } },
      ],
    } as never);
    await importOsmPlaces({ name: 'Test Pradesh', nameTe: null }, [{ osmId: 7, name: 'YSR Kadapa District', nameTe: null, lat: null, lon: null, mandals }]);
    expect(buildSearchKeys({ en: 'Pedda Vadlapudi', te: null }, [])).toEqual(['pedda vadlapudi', 'vadlapudi']);
    expect((await searchLocations('vadla', 10)).map((l) => l.name.en)).toEqual(['Pedda Vadlapudi']);
    expect((await searchLocations('వడ్ల', 10)).map((l) => l.name.en)).toEqual(['Pedda Vadlapudi']);
    expect((await searchLocations('kadapa', 10)).map((l) => l.name.en)).toEqual(['YSR Kadapa']);
  });
});

describe('place search ranking', () => {
  it('puts the exact name first, before villages that only end with it', async () => {
    const { searchLocations } = await import('../src/modules/geo/geo.service');
    const villages = ['Beera Kuppam', 'Chintha Kuppam', 'Anna Kuppam', 'Kuppam'].map((name, i) => ({ type: 'node', id: 10 + i, lat: 12.7, lon: 78.3, tags: { place: 'village', name } }));
    const mandals = parseDistrictPlaces({ elements: [{ type: 'relation', id: 1, tags: { name: 'Kuppam Mandal' } }, ...villages] } as never);
    await importOsmPlaces({ name: 'Test Pradesh', nameTe: null }, [{ osmId: 7, name: 'Chittoor District', nameTe: null, lat: null, lon: null, mandals }]);
    const found = await searchLocations('kuppam', 10);
    expect(found.slice(0, 2).map((l) => `${l.level}:${l.name.en}`)).toEqual(['mandal:Kuppam', 'village:Kuppam']);
    expect(found.map((l) => l.name.en)).toContain('Beera Kuppam');
  });
});
