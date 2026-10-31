import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../src/modules/audit/audit';
import { createTree } from './fixtures';
import { buildApp, client, userWithRoles, useTestDb } from './helpers';

useTestDb();

describe('locations (AC1, AC2)', () => {
  it('admins build the hierarchy; detail shows ancestors and a readable label', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);

    const res = await client(app).get(`/api/v1/locations/${tree.village.id}`).expect(200);
    expect(res.body.location).toMatchObject({
      level: 'village',
      label: 'Alpha Village, Alpha Mandal, Test District',
      labelTe: null, // the village has no Telugu name yet, so no Telugu label
      aliases: ['Alphapuram'],
    });
    expect(res.body.location.ancestors.map((a: { level: string }) => a.level)).toEqual(['state', 'district', 'mandal']);
    expect(await AuditEventModel.countDocuments({ action: 'geo.location_created' })).toBe(5);
  });

  it('browses children in name order; top level lists states', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const anon = client(app);
    const states = await anon.get('/api/v1/locations').expect(200);
    expect(states.body.items.map((l: { name: { en: string } }) => l.name.en)).toEqual(['Test State']);
    const mandals = await anon.get(`/api/v1/locations?parentId=${tree.district.id}`).expect(200);
    expect(mandals.body.items.map((l: { name: { en: string } }) => l.name.en)).toEqual(['Alpha Mandal', 'Beta Mandal']);
  });

  it('the level must fit the parent', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    await admin.post('/api/v1/admin/locations', { parentId: tree.district.id, level: 'village', nameEn: 'Skip Level' }).expect(400);
    await admin.post('/api/v1/admin/locations', { parentId: null, level: 'district', nameEn: 'Orphan District' }).expect(400);
    await admin.post('/api/v1/admin/locations', { parentId: tree.village.id, level: 'village', nameEn: 'Below Village' }).expect(400);
  });

  it('rejects duplicate names under one parent and duplicate LGD codes', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    await admin.post('/api/v1/admin/locations', { parentId: tree.district.id, level: 'mandal', nameEn: 'alpha  mandal' }).expect(409);
    await admin.post('/api/v1/admin/locations', { parentId: tree.mandalB.id, level: 'village', nameEn: 'One', lgdCode: '123' }).expect(201);
    await admin.post('/api/v1/admin/locations', { parentId: tree.mandalB.id, level: 'village', nameEn: 'Two', lgdCode: '123' }).expect(409);
  });

  it('searches by English, Telugu and alias prefixes', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    const anon = client(app);
    const names = async (q: string) =>
      (await anon.get(`/api/v1/locations/search?q=${encodeURIComponent(q)}`).expect(200)).body.items.map(
        (l: { name: { en: string } }) => l.name.en,
      );
    expect(await names('alpha')).toEqual(['Alpha Mandal', 'Alpha Village']);
    expect(await names('ఆల్ఫా')).toEqual(['Alpha Mandal']);
    expect(await names('alphap')).toEqual(['Alpha Village']);
    expect(await names('.*')).toEqual([]);
  });

  it('admins can rename and add a Telugu name; only admins may change locations', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const tree = await createTree(admin);
    const res = await admin.patch(`/api/v1/admin/locations/${tree.village.id}`, { nameTe: 'ఆల్ఫా గ్రామం' }).expect(200);
    expect(res.body.location.labelTe).toBe('ఆల్ఫా గ్రామం, ఆల్ఫా మండలం, పరీక్ష జిల్లా');
    await editor.post('/api/v1/admin/locations', { parentId: null, level: 'state', nameEn: 'Nope' }).expect(403);
    await client(app).post('/api/v1/admin/locations', { parentId: null, level: 'state', nameEn: 'Nope' }).expect(401);
  });
});

describe('categories', () => {
  it('lists the eight categories from the spec in Telugu and English', async () => {
    const { app } = buildApp();
    const res = await client(app).get('/api/v1/categories').expect(200);
    expect(res.body.items.map((c: { slug: string }) => c.slug)).toEqual([
      'local_events',
      'education',
      'employment',
      'agriculture',
      'civic_issues',
      'government_announcements',
      'public_safety',
      'community_news',
    ]);
    expect(res.body.items[1].name).toEqual({ en: 'Education', te: 'విద్య' });
  });
});
