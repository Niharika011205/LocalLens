import { describe, expect, it } from 'vitest';
import { importLgd } from '../src/modules/geo/lgd-import';
import { LocationModel } from '../src/modules/geo/location.model';
import { buildApp, client, useTestDb } from './helpers';

useTestDb();

/**
 * A file shaped like LGD's "All Villages of India" export (same columns). Names are made up: real places only ever
 * come from the official file.
 */
function allIndiaCsv(villagesPerMandal: number) {
  const header = 'S No.,State Code,State Name (In English),District Code,District Name (In English),Sub-District Code,Sub-District Name (In English),Village Code,Village Version,Village Name (In English),Village Name (In Local language)';
  const rows = [header];
  let n = 0;
  const states = [
    { code: '91', name: 'Test Telugu State', local: (i: number) => `పరీక్ష గ్రామం ${i}` },
    { code: '92', name: 'Test Hindi State', local: (i: number) => `परीक्षा गाँव ${i}` },
    { code: '93', name: 'Test Other State', local: () => '' },
  ];
  for (const [s, st] of states.entries()) {
    for (let d = 1; d <= 2; d++) {
      for (let m = 1; m <= 5; m++) {
        for (let v = 1; v <= villagesPerMandal; v++) {
          n++;
          const villageCode = String(9_000_000 + n);
          // Two villages per mandal share a name, as often happens in LGD.
          const name = v === 2 ? 'Rampur' : v === 1 ? 'Rampur' : `Village ${s}${d}${m}-${v}`;
          rows.push([n, st.code, st.name, `${st.code}${d}`, `District ${st.code}-${d}`, `${st.code}${d}${m}`, `Mandal ${st.code}-${d}-${m}`, villageCode, 1, name, st.local(v)].join(','));
        }
      }
    }
  }
  return rows.join('\n');
}

describe('LGD import at India scale', () => {
  it('imports 30,000 villages in batches: states, districts, mandals, same-name villages, local names', async () => {
    const csv = allIndiaCsv(1000); // 3 states × 2 districts × 5 mandals × 1,000 villages
    const started = Date.now();
    const summary = await importLgd(csv);
    const seconds = (Date.now() - started) / 1000;
    expect(summary.created).toEqual({ state: 3, district: 6, mandal: 30, village: 30_000 });
    expect(seconds).toBeLessThan(60); // ~6.5 lakh villages therefore take minutes, not hours

    // Same-name villages in one mandal are both kept.
    const mandal = await LocationModel.findOne({ level: 'mandal', lgdCode: '9111' });
    expect(await LocationModel.countDocuments({ parentId: mandal!._id, 'name.en': 'Rampur' })).toBe(2);
    // Telugu local names become the Telugu name; Hindi ones are searchable aliases, never shown as "Telugu".
    const teluguVillage = await LocationModel.findOne({ level: 'village', 'name.en': 'Village 011-3' });
    expect(teluguVillage?.name.te).toBe('పరీక్ష గ్రామం 3');
    const hindiVillage = await LocationModel.findOne({ level: 'village', 'name.en': 'Village 111-3' });
    expect(hindiVillage).toMatchObject({ name: { te: null }, aliases: ['परीक्षा गाँव 3'] });

    // Search finds villages by English, Telugu and Hindi names, with the mandal and district in the label.
    const { app } = buildApp();
    const find = async (q: string) => (await client(app).get(`/api/v1/locations/search?q=${encodeURIComponent(q)}`).expect(200)).body.items;
    expect((await find('Village 111-3'))[0]).toMatchObject({ level: 'village', label: expect.stringContaining('Mandal 92-1-1') });
    expect((await find('परीक्षा गाँव 3')).length).toBeGreaterThan(0);
    expect((await find('పరీక్ష గ్రామం 3')).length).toBeGreaterThan(0);

    // Re-running the same file changes nothing.
    const again = await importLgd(csv);
    expect(again.created).toEqual({ state: 0, district: 0, mandal: 0, village: 0 });
    expect(await LocationModel.countDocuments({ level: 'village' })).toBe(30_000);
  });

  it('can import one state from the all-India file', async () => {
    const summary = await importLgd(allIndiaCsv(20), { stateCode: '92' });
    expect(summary.created).toEqual({ state: 1, district: 2, mandal: 10, village: 200 });
    expect(await LocationModel.countDocuments({ level: 'state' })).toBe(1);
  });
});
