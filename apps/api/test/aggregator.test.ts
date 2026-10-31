import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { findOgDescription, findOgImage, importAll, isSmallImage, parseFeed, plainText, pruneImported, repairImportedText, shorten, type FetchLike } from '../src/modules/aggregator/aggregator';
import type { NewsSource } from '../src/modules/aggregator/sources';
import { JobModel } from '../src/modules/jobs/jobs';
import { configureMedia } from '../src/modules/media/media';
import { ArticleModel } from '../src/modules/publishing/article.model';
import { createTree } from './fixtures';
import { buildApp, client, ORIGIN, signUp, testConfig, userWithRoles, useTestDb } from './helpers';

useTestDb();

const now = new Date();
const rfc822 = (d: Date) => d.toUTCString();

const RSS = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example AP</title>
<item><title><![CDATA[Cyclone warning for coastal Andhra Pradesh]]></title><link>https://news.example/ap/cyclone-warning.html?utm=x</link>
<description><![CDATA[<p>The IMD has issued a cyclone warning for coastal districts &amp; fishermen are advised not to venture into the sea.</p>]]></description>
<pubDate>${rfc822(new Date(now.getTime() - 3600_000))}</pubDate><media:content url="https://img.news.example/cyclone.jpg" medium="image" width="1200" height="675"/></item>
<item><title>పరీక్ష జిల్లా లో పాఠశాలలకు సెలవు</title><link>https://news.example/ap/school-holiday.html</link>
<description>భారీ వర్షాల కారణంగా పాఠశాలలకు రెండు రోజులు సెలవు ప్రకటించారు.</description>
<content:encoded><![CDATA[<p><img src="https://img.news.example/school.jpg" alt=""/></p><p>Full text we must not copy.</p>]]></content:encoded>
<pubDate>${rfc822(new Date(now.getTime() - 7200_000))}</pubDate></item>
<item><title>Story with no photo in the feed</title><link>https://news.example/ap/no-photo.html</link><description>Short text.</description><pubDate>${rfc822(now)}</pubDate></item>
<item><title>Very old story</title><link>https://news.example/ap/old.html</link><description>Old.</description><pubDate>${rfc822(new Date(now.getTime() - 30 * 86_400_000))}</pubDate></item>
<item><title>Insecure link is skipped</title><link>http://news.example/ap/http.html</link></item>
</channel></rss>`;

const PAGE = `<html><head><meta property="og:image" content="https://img.news.example/og.jpg"/></head><body>…</body></html>`;

function fakeFetch(routes: Record<string, { status: number; body: string }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: '' };
    return { ok: r.status < 400, status: r.status, text: async () => r.body, headers: { get: () => null } };
  }) as unknown as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const SOURCE: NewsSource = { id: 'example', name: 'Example News', siteUrl: 'https://news.example', feedUrl: 'https://news.example/feed', language: 'te', enabled: true };

afterEach(() => configureMedia({ folder: 'locallens' })); // back to database storage

describe('feed parsing', () => {
  it('reads RSS and Atom, keeps only a short summary, and finds the photo', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(4); // the http:// item is dropped
    expect(items[0]).toMatchObject({ title: 'Cyclone warning for coastal Andhra Pradesh', image: 'https://img.news.example/cyclone.jpg' });
    expect(items[0]!.summary).toBe('The IMD has issued a cyclone warning for coastal districts & fishermen are advised not to venture into the sea.');
    expect(items[1]).toMatchObject({ image: 'https://img.news.example/school.jpg' });
    expect(items[1]!.summary).not.toContain('Full text'); // the feed's summary, never the full article
    expect(items[2]!.image).toBeNull();
    // Our article page gets the publisher's excerpt (longer than the card), never content:encoded (the full article).
    const long = 'పదం '.repeat(400);
    const [withLong] = parseFeed(`<rss><channel><item><title>Long one</title><link>https://news.example/long</link><description>${long}</description><content:encoded><![CDATA[<p>FULL ARTICLE TEXT</p>]]></content:encoded></item></channel></rss>`);
    expect(withLong!.summary.length).toBeLessThanOrEqual(560);
    expect(withLong!.excerpt.length).toBeGreaterThan(560);
    expect(withLong!.excerpt.length).toBeLessThanOrEqual(1000);
    expect(withLong!.excerpt).not.toContain('FULL ARTICLE');

    const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom story</title><link rel="alternate" href="https://a.example/x"/><summary>Hi there</summary><updated>2026-10-29T10:00:00Z</updated></entry></feed>`);
    expect(atom).toEqual([expect.objectContaining({ title: 'Atom story', link: 'https://a.example/x', summary: 'Hi there' })]);

    expect(shorten('word '.repeat(200)).length).toBeLessThanOrEqual(560);
    expect(plainText('A &#8211; B <b>bold</b> &amp; C')).toBe('A – B bold & C');
    expect(findOgImage(PAGE)).toBe('https://img.news.example/og.jpg');
    expect(findOgImage('<meta property="og:image" content="http://insecure/x.jpg">')).toBeNull();
  });
});

describe('messy feeds (real cases)', () => {
  it('decodes HTML that was escaped twice, keeping Telugu joiners (ABP Desam)', () => {
    const abp = '&lt;p&gt;అమరావతి: ఆంధ్రప్రదేశ్&amp;zwnj;లోని నగర పంచాయతీలు&lt;/p&gt;&lt;p&gt;రెండో పేరా.&lt;/p&gt;';
    expect(plainText(abp)).toBe('అమరావతి: ఆంధ్రప్రదేశ్\u200cలోని నగర పంచాయతీలు రెండో పేరా.');
  });

  it('drops CMS leftovers (Sakshi) and falls back to the page’s own description', async () => {
    const sakshiItem = `<rss><channel><item><title>చిలకలూరిపేటలో ప్రచారం</title><link>https://news.example/sakshi-like.html</link>
      <description>&lt;span&gt;చిలకలూరిపేటలో ప్రచారం&lt;/span&gt;&lt;span&gt;satya.k&lt;/span&gt;&lt;time&gt;Fri, 10/30/2026 - 18:11&lt;/time&gt;
      &lt;div&gt;&lt;img src="https://img.news.example/s.jpg"&gt;&lt;/div&gt; Display on listing page top story No</description>
      <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
    const [item] = parseFeed(sakshiItem);
    expect(item!.summary).not.toMatch(/Display on listing|10\/30\/2026|చిలకలూరిపేటలో ప్రచారం/);
    expect(item!.summary.length).toBeLessThan(30); // nothing usable left → the importer reads the page instead
    expect(item!.image).toBe('https://img.news.example/s.jpg');
    expect(findOgDescription('<meta property="og:description" content="మాజీ మంత్రి విడదల రజిని కూటమి ప్రభుత్వంపై విమర్శలు చేశారు, ప్రచారంలో.">')).toMatch(/^మాజీ మంత్రి/);

    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    const page = '<meta property="og:description" content="మాజీ మంత్రి విడదల రజిని కూటమి ప్రభుత్వంపై తీవ్ర విమర్శలు చేశారు.">';
    await importAll({ fetcher: fakeFetch({ 'https://news.example/feed': { status: 200, body: sakshiItem }, 'https://news.example/sakshi-like.html': { status: 200, body: page } }), keepDays: 7, sources: [SOURCE] });
    const saved = await ArticleModel.findOne({ sourceType: 'external' }).lean();
    expect(saved?.summary).toBe('మాజీ మంత్రి విడదల రజిని కూటమి ప్రభుత్వంపై తీవ్ర విమర్శలు చేశారు.');
  });

  it('repairs stories saved before the cleaner (re-clean, or drop so the next import re-adds them)', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    await importAll({ fetcher: fakeFetch({ 'https://news.example/feed': { status: 200, body: RSS } }), keepDays: 7, sources: [SOURCE] });
    const [a, b] = await ArticleModel.find({ sourceType: 'external' }).limit(2);
    await ArticleModel.updateOne({ _id: a!._id }, { $set: { summary: '<p>అమరావతి: ఆంధ్రప్రదేశ్&zwnj;లోని నగర పంచాయతీలు, మున్సిపాలిటీలు</p>' } });
    // Older imports stored the same text as summary and body.
    await ArticleModel.updateOne({ _id: b!._id }, { $set: { summary: 'satya.k Display on listing page top story No', body: 'satya.k Display on listing page top story No' } });
    expect(await repairImportedText()).toMatchObject({ fixed: 1, dropped: 1 });
    expect((await ArticleModel.findById(a!._id).lean())?.summary).toBe('అమరావతి: ఆంధ్రప్రదేశ్\u200cలోని నగర పంచాయతీలు, మున్సిపాలిటీలు');
    expect(await ArticleModel.findById(b!._id)).toBeNull();
  });
});

describe('photo quality', () => {
  it('recognises thumbnails and prefers the biggest picture an item offers', () => {
    expect(isSmallImage('https://www.sakshi.com/s3/files/styles/medium/s3/article_images/2026/10/30/car_0.jpg?itok=x')).toBe(true);
    expect(isSmallImage('https://ntvtelugu.com/wp-content/uploads/2026/10/sec-1-300x169.jpg')).toBe(true);
    expect(isSmallImage('https://ntvtelugu.com/wp-content/uploads/2026/10/sec-1-1024x576.jpg')).toBe(false);
    expect(isSmallImage('https://static.asianetnews.com/images/w-1280,h-720,format-jpg,imgid-x')).toBe(false);
    expect(isSmallImage('https://x.example/a.jpg', 220)).toBe(true);
    const [item] = parseFeed(`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Two pictures</title><link>https://news.example/two</link>
      <media:content url="https://img.news.example/small.jpg" medium="image" width="300"/><media:content url="https://img.news.example/big.jpg" medium="image" width="1200"/></item></channel></rss>`);
    expect(item).toMatchObject({ image: 'https://img.news.example/big.jpg', imageSmall: false });
  });

  it('swaps a thumbnail for the page’s large share picture, on import and for stories already saved', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    const feed = `<rss><channel><item><title>Thumbnail only story here</title><link>https://news.example/thumb.html</link>
      <description>&lt;img src="https://img.news.example/styles/medium/t.jpg" width="220"&gt; A long enough summary of the story for the card to use as it is.</description>
      <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
    const page = '<meta property="og:image" content="https://img.news.example/big-1200.jpg">';
    const fetcher = fakeFetch({ 'https://news.example/feed': { status: 200, body: feed }, 'https://news.example/thumb.html': { status: 200, body: page } });
    await importAll({ fetcher, keepDays: 7, sources: [SOURCE] });
    expect((await ArticleModel.findOne({ sourceType: 'external' }).lean())?.imageUrl).toBe('https://img.news.example/big-1200.jpg');

    // A story saved earlier with the thumbnail gets upgraded once; a page without a bigger picture is not re-fetched.
    await ArticleModel.updateMany({ sourceType: 'external' }, { $set: { imageUrl: 'https://img.news.example/styles/medium/t.jpg' } });
    expect((await repairImportedText(fetcher)).photos).toBe(1);
    expect((await ArticleModel.findOne({ sourceType: 'external' }).lean())?.imageUrl).toBe('https://img.news.example/big-1200.jpg');
    await ArticleModel.updateMany({ sourceType: 'external' }, { $set: { imageUrl: 'https://img.news.example/styles/medium/t.jpg' } });
    const calls = fetcher.calls.length;
    await repairImportedText(fetcher);
    expect(fetcher.calls.length).toBe(calls);
  });
});

describe('news import', () => {
  it('adds new stories once, with photo, source, place and topic; old and duplicate items are skipped; no alerts', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const fetcher = fakeFetch({ 'https://news.example/feed': { status: 200, body: RSS }, 'https://news.example/ap/no-photo.html': { status: 200, body: PAGE } });

    const [first] = await importAll({ fetcher, keepDays: 7, sources: [SOURCE] });
    expect(first).toMatchObject({ fetched: 4, added: 3, withPhoto: 3, error: null });
    const [again] = await importAll({ fetcher, keepDays: 7, sources: [SOURCE] });
    expect(again!.added).toBe(0); // the same links are never added twice
    expect(await JobModel.countDocuments({ type: 'notify_new_article' })).toBe(0); // imports never alert followers
    // …not even through the repair sweeper that re-sends recent publish events (regression).
    const { runDueJobs, runSweepers } = await import('../src/modules/jobs/jobs');
    const { NotificationModel } = await import('../src/modules/notifications/notifications');
    const { pino } = await import('pino');
    const follower = (await signUp(app, 'follower@example.in')).c;
    await follower.put(`/api/v1/me/follows/location/${tree.district.id}`, {}).expect(204);
    await runSweepers(pino({ level: 'silent' }));
    await JobModel.updateMany({ status: 'pending' }, { $set: { runAfter: new Date(0) } });
    await runDueJobs(pino({ level: 'silent' }));
    expect(await NotificationModel.countDocuments({ kind: 'new_article' })).toBe(0);

    const feed = (await client(app).get('/api/v1/articles').expect(200)).body.items;
    const cyclone = feed.find((a: { headline: string }) => a.headline.startsWith('Cyclone'));
    expect(cyclone).toMatchObject({
      trustLabel: 'external_source',
      sourceType: 'external',
      imageUrl: 'https://img.news.example/cyclone.jpg',
      externalSource: { name: 'Example News', url: 'https://news.example/ap/cyclone-warning.html?utm=x' },
      category: expect.objectContaining({ slug: 'public_safety' }),
    });
    // Mentions a district by its Telugu name → filed under that district, and the school topic is detected.
    const school = feed.find((a: { headline: string }) => a.headline.includes('సెలవు'));
    expect(school).toMatchObject({ location: expect.objectContaining({ id: tree.district.id }), category: expect.objectContaining({ slug: 'education' }) });
    // No photo in the feed → the publisher page's own share image.
    expect(feed.find((a: { headline: string }) => a.headline.startsWith('Story with no photo')).imageUrl).toBe('https://img.news.example/og.jpg');
    // Place feeds include district-level imports.
    expect((await client(app).get(`/api/v1/articles?locationId=${tree.district.id}`).expect(200)).body.items.map((a: { headline: string }) => a.headline)).toContain(school.headline);
  });

  it('a broken feed is reported without stopping the others; old imports are pruned, our own posts never', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    const fetcher = fakeFetch({ 'https://news.example/feed': { status: 200, body: RSS } });
    const results = await importAll({ fetcher, keepDays: 7, sources: [{ ...SOURCE, id: 'down', feedUrl: 'https://down.example/feed' }, SOURCE] });
    expect(results.map((r) => [r.error, r.added])).toEqual([['HTTP 404', 0], [null, 3]]);

    await ArticleModel.updateMany({ sourceType: 'external' }, { $set: { firstPublishedAt: new Date(Date.now() - 10 * 86_400_000) } });
    expect(await pruneImported(7)).toBe(3);
    expect(await ArticleModel.countDocuments({ sourceType: 'external' })).toBe(0);
  });

  it('readers can report imported stories; enough reports hide them like reporter posts', async () => {
    const { createRateLimiters, DEFAULT_LIMITS } = await import('../src/middleware/rate-limit');
    const limiters = createRateLimiters({ kind: 'memory' }, { ...DEFAULT_LIMITS, register: { points: 100, duration: 3600 } });
    const { app } = buildApp({ limiters, config: testConfig({ REPORTS_TO_REMOVE: '2' }) });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    await createTree(admin);
    await importAll({ fetcher: fakeFetch({ 'https://news.example/feed': { status: 200, body: RSS } }), keepDays: 7, sources: [SOURCE] });
    const story = (await client(app).get('/api/v1/articles').expect(200)).body.items[0];
    const a = (await signUp(app, 'r1@example.in')).c;
    const b = (await signUp(app, 'r2@example.in')).c;
    await a.post(`/api/v1/articles/${story.id}/reports`, { reason: 'false_information' }).expect(201);
    expect((await b.post(`/api/v1/articles/${story.id}/reports`, { reason: 'false_information' }).expect(201)).body.removed).toBe(true);
    await client(app).get(`/api/v1/articles/${story.slug}`).expect(404);
  });

  it('admins can run an import now and list the sources; others cannot', async () => {
    const { app } = buildApp();
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const reader = await userWithRoles(app, 'reader@example.in', ['reader']);
    await reader.get('/api/v1/admin/news/sources').expect(403);
    const sources = (await admin.get('/api/v1/admin/news/sources').expect(200)).body.items;
    const names = sources.filter((s: { enabled: boolean }) => s.enabled).map((s: { name: string }) => s.name);
    expect(names).toEqual(expect.arrayContaining(['The Hindu', 'TV9 Telugu', 'NTV Telugu', '10TV', 'The New Indian Express', 'ABP Desam', 'Asianet News Telugu', 'BIG TV', 'Sakshi']));
    expect(sources.find((s: { id: string }) => s.id === 'telugu360').enabled).toBe(false);
  });

  it('lets the page show photos from Cloudinary and news sites (img-src https:, blob: for the preview)', async () => {
    const res = await client(buildApp().app).get('/healthz');
    expect(res.headers['content-security-policy']).toMatch(/img-src 'self' data: blob: https:/);
  });
});

describe('Cloudinary photos', () => {
  it('uploads the cleaned photo to Cloudinary, serves it from there, and deletes it when the author deletes the post', async () => {
    const uploads: { bytes: number; folder: string; hasExif: boolean }[] = [];
    const destroyed: string[] = [];
    const { app } = buildApp({ config: testConfig({ REPORTER_SELF_SIGNUP: 'true' }) });
    // After building the app (which configures storage from its settings): use a fake Cloudinary.
    configureMedia({
      folder: 'locallens-test',
      uploader: async (image, { folder }) => {
        uploads.push({ bytes: image.length, folder, hasExif: !!(await sharp(image).metadata()).exif });
        return { secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/locallens-test/abc.webp', public_id: 'locallens-test/abc' };
      },
      destroy: async (id) => void destroyed.push(id),
    });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const civic = (await client(app).get('/api/v1/categories').expect(200)).body.items[0].id;
    const { c: reporter } = await signUp(app, 'reporter@example.in', { requestReporter: true });
    const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: 'blue' } }).withExif({ IFD0: { Artist: 'GPS' } }).jpeg().toBuffer();
    const res = await reporter.agent
      .post('/api/v1/posts')
      .set('Origin', ORIGIN)
      .field({ headline: 'Bridge repaired in Alpha Village', summary: 'The bridge over the canal was repaired and reopened today.', language: 'en', locationId: tree.village.id, categoryId: civic })
      .attach('photo', photo, { filename: 'p.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(res.body.post.imageUrl).toBe('https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,c_limit,w_1280/v1/locallens-test/abc.webp');
    expect(uploads).toEqual([{ bytes: expect.any(Number), folder: 'locallens-test', hasExif: false }]); // cleaned before upload

    await reporter.del(`/api/v1/posts/${res.body.post.id}`).expect(204);
    expect(destroyed).toEqual(['locallens-test/abc']);
  });

  it('tells the reporter to retry when Cloudinary is down, instead of losing the post silently', async () => {
    const { app } = buildApp({ config: testConfig({ REPORTER_SELF_SIGNUP: 'true' }) });
    configureMedia({ folder: 'x', uploader: async () => Promise.reject(new Error('down')) });
    const admin = await userWithRoles(app, 'admin@example.in', ['reader', 'admin']);
    const tree = await createTree(admin);
    const civic = (await client(app).get('/api/v1/categories').expect(200)).body.items[0].id;
    const { c: reporter } = await signUp(app, 'reporter@example.in', { requestReporter: true });
    const photo = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const res = await reporter.agent
      .post('/api/v1/posts')
      .set('Origin', ORIGIN)
      .field({ headline: 'Bridge repaired in Alpha Village', summary: 'The bridge over the canal was repaired and reopened today.', language: 'en', locationId: tree.village.id, categoryId: civic })
      .attach('photo', photo, { filename: 'p.jpg', contentType: 'image/jpeg' })
      .expect(503);
    expect(res.body.error.message).toMatch(/Try again, or post without a photo/);
    expect(await ArticleModel.countDocuments({ trustLabel: 'reporter_post' })).toBe(0);
  });
});

describe('a brand-new database', () => {
  it('shows imported news even before any places are added (Andhra Pradesh is created for it)', async () => {
    const { ensureCategories } = await import('../src/modules/catalog/catalog'); // done at app start
    await ensureCategories();
    const { LocationModel } = await import('../src/modules/geo/location.model');
    expect(await LocationModel.countDocuments()).toBe(0);

    await importAll({ fetcher: fakeFetch({ 'https://news.example/feed': { status: 200, body: RSS } }), keepDays: 7, sources: [SOURCE] });
    const state = await LocationModel.findOne({ level: 'state' }).lean();
    expect(state).toMatchObject({ name: { en: 'Andhra Pradesh', te: 'ఆంధ్రప్రదేశ్' } });
    expect(await ArticleModel.countDocuments({ sourceType: 'external', status: 'published' })).toBeGreaterThan(0);
    expect(await LocationModel.countDocuments({ level: 'state' })).toBe(1); // only once, however many imports run
    await importAll({ fetcher: fakeFetch({}), keepDays: 7, sources: [SOURCE] });
    expect(await LocationModel.countDocuments({ level: 'state' })).toBe(1);
  });
});
