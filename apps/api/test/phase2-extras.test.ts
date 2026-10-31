import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { importLgd, parseCsv } from '../src/modules/geo/lgd-import';
import { LocationModel } from '../src/modules/geo/location.model';
import { articleBody, categoryId, createTree } from './fixtures';
import { ArticleModel } from '../src/modules/publishing/article.model';
import { buildApp, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

// Fictional rows in the data.gov.in column layout. Codes and names are invented for the test only.
const CSV = [
  'stateCode,stateNameEnglish,districtCode,districtNameEnglish,subdistrictCode,subdistrictNameEnglish,villageCode,villageNameEnglish,villageNameLocal',
  '91,Test State,9101,Test District,910101,Alpha Mandal,91010101,Alpha Village,ఆల్ఫా గ్రామం',
  '91,Test State,9101,Test District,910101,Alpha Mandal,91010102,"Gamma, Village",',
  '91,Test State,9101,Test District,910102,Delta Mandal,91010201,Delta Village,డెల్టా',
].join('\r\n');

describe('LGD import', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,"b, c","d ""q"""\n1,2,3')).toEqual([['a', 'b, c', 'd "q"'], ['1', '2', '3']]);
  });

  it('creates the hierarchy, links places admins already added, and is idempotent', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin); // manual: Test State › Test District › Alpha Mandal › Alpha Village

    const first = await importLgd(CSV);
    expect(first.rows).toBe(3);
    expect(first.linked).toEqual({ state: 1, district: 1, mandal: 1, village: 1 });
    expect(first.created).toEqual({ state: 0, district: 0, mandal: 1, village: 2 });

    const village = await LocationModel.findById(tree.village.id);
    expect(village?.lgdCode).toBe('91010101');
    expect(village?.name.te).toBe('ఆల్ఫా గ్రామం');
    const gamma = await LocationModel.findOne({ lgdCode: '91010102' });
    expect(gamma?.name.en).toBe('Gamma, Village');
    expect(gamma?.source.dataset).toBe('lgd');
    expect(gamma?.ancestorIds.map(String)).toEqual([tree.state.id, tree.district.id, tree.mandalA.id]);

    const again = await importLgd(CSV);
    expect(again.created).toEqual({ state: 0, district: 0, mandal: 0, village: 0 });
    expect(again.linked).toEqual({ state: 0, district: 0, mandal: 0, village: 0 });
  });

  it('dry run writes nothing; bad files are rejected with a clear message', async () => {
    const summary = await importLgd(CSV, { dryRun: true });
    expect(summary.created.village).toBe(3);
    expect(await LocationModel.countDocuments()).toBe(0);
    await expect(importLgd('name,code\nx,1')).rejects.toThrow(/Missing columns/);
    await expect(importLgd(CSV.replace('91010201', 'abc'))).rejects.toThrow(/numeric/);
  });

  it('can limit an import to one district', async () => {
    const other = `${CSV}\r\n91,Test State,9102,Other District,910201,Omega Mandal,91020101,Omega Village,`;
    const summary = await importLgd(other, { districtCode: '9102' });
    expect(summary.rows).toBe(1);
    expect(await LocationModel.exists({ lgdCode: '91010101' })).toBeNull();
  });
});

describe('link previews (Open Graph)', () => {
  it('adds escaped article tags for published articles only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'locallens-web-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>LocalLens</title></head><body></body></html>');
    const { app } = buildApp({ config: { ...testConfig(), STATIC_DIR: dir } });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const tree = await createTree(admin);
    const cat = await categoryId(editor, 'civic_issues');
    const article = (
      await editor.post('/api/v1/editorial/articles', articleBody(tree.village.id, cat, { headline: 'Water "tanker" <script> arrives' })).expect(201)
    ).body.article;

    const page = await request(app).get(`/articles/${article.slug}`).expect(200);
    expect(page.text).toContain('<meta property="og:title" content="Water &quot;tanker&quot; &lt;script&gt; arrives" />');
    expect(page.text).toContain(`<meta property="og:url" content="http://localhost:5180/articles/${article.slug}" />`);
    expect(page.text).not.toContain('<script> arrives');

    await editor.post(`/api/v1/editorial/articles/${article.id}/unpublish`, { reason: 'Checking the facts' }).expect(200);
    const hidden = await request(app).get(`/articles/${article.slug}`).expect(200);
    expect(hidden.text).not.toContain('og:title');
    expect(hidden.text).not.toContain('tanker');
  });

  it('shows the photo in previews, and picks up a new build of the page without a restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'locallens-web-'));
    const index = path.join(dir, 'index.html');
    await writeFile(index, '<!doctype html><html><head><title>LocalLens</title><script src="/assets/index-OLD.js"></script></head><body></body></html>');
    const { app } = buildApp({ config: { ...testConfig(), STATIC_DIR: dir } });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const editor = await userWithRoles(app, 'editor@example.in', ['reader', 'editor']);
    const tree = await createTree(admin);
    const cat = await categoryId(editor, 'civic_issues');
    const article = (await editor.post('/api/v1/editorial/articles', articleBody(tree.village.id, cat)).expect(201)).body.article;
    await ArticleModel.updateOne({ _id: article.id }, { $set: { imageUrl: 'https://res.cloudinary.com/demo/image/upload/x.webp' } });

    const first = await request(app).get(`/articles/${article.slug}`).expect(200);
    expect(first.text).toContain('<meta property="og:image" content="https://res.cloudinary.com/demo/image/upload/x.webp" />');
    expect(first.text).toContain('summary_large_image');
    expect(first.text).toContain('index-OLD.js');

    // A new build (different asset names) while the server keeps running.
    await new Promise((r) => setTimeout(r, 20)); // a different modification time
    await writeFile(index, '<!doctype html><html><head><title>LocalLens</title><script src="/assets/index-NEW.js"></script></head><body></body></html>');
    const second = await request(app).get(`/articles/${article.slug}`).expect(200);
    expect(second.text).toContain('index-NEW.js');
  });
});
