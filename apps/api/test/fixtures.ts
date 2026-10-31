/**
 * Test-only location tree. These are fictional places ("Test District" etc.), deliberately not real Guntur data:
 * real locations come from admins or the LGD import, never from code.
 */
import type { client } from './helpers';

type Client = ReturnType<typeof client>;

export async function createTree(admin: Client) {
  const mk = async (body: object) => (await admin.post('/api/v1/admin/locations', body).expect(201)).body.location;
  const state = await mk({ parentId: null, level: 'state', nameEn: 'Test State', nameTe: 'పరీక్ష రాష్ట్రం' });
  const district = await mk({ parentId: state.id, level: 'district', nameEn: 'Test District', nameTe: 'పరీక్ష జిల్లా' });
  const mandalA = await mk({ parentId: district.id, level: 'mandal', nameEn: 'Alpha Mandal', nameTe: 'ఆల్ఫా మండలం' });
  const mandalB = await mk({ parentId: district.id, level: 'mandal', nameEn: 'Beta Mandal' });
  const village = await mk({ parentId: mandalA.id, level: 'village', nameEn: 'Alpha Village', aliases: ['Alphapuram'] });
  return { state, district, mandalA, mandalB, village };
}

export async function categoryId(c: Client, slug: string): Promise<string> {
  const res = await c.get('/api/v1/categories').expect(200);
  return res.body.items.find((x: { slug: string }) => x.slug === slug).id;
}

export function articleBody(locationId: string, catId: string, overrides: Record<string, unknown> = {}) {
  return {
    headline: 'Road repairs start in Alpha Village',
    summary: 'The main road will be repaired over the next two weeks.',
    body: 'Repairs on the main road begin on Monday. Traffic will be diverted through the market road.',
    language: 'en',
    locationId,
    categoryId: catId,
    trustLabel: 'editor_verified',
    sourceType: 'staff',
    ...overrides,
  };
}
