import { createHash } from 'node:crypto';
import { Router } from 'express';
import { XMLParser } from 'fast-xml-parser';
import { Types } from 'mongoose';
import type { Logger } from 'pino';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { CategoryModel } from '../catalog/catalog';
import { LocationModel } from '../geo/location.model';
import { enqueue, registerJobHandler, registerSweeper } from '../jobs/jobs';
import { ContentReportModel } from '../moderation/reports';
import { ArticleModel } from '../publishing/article.model';
import { makeSlug } from '../publishing/articles.service';
import { NEWS_SOURCES, type NewsSource } from './sources';

/**
 * Real news from other sites, alongside our reporters' posts.
 *
 * What we take, and why only this: the publishers' own RSS feeds, which exist so others can show their headlines.
 * We keep the headline, the feed's own short summary (cut to ~60 words), the photo the publisher attached to the item,
 * the time, and a link back. We never copy the full article: readers tap "Read on <site>" for that. Every imported
 * story is labelled with its source.
 *
 * Imported stories are ordinary articles (sourceType "external", label "external_source"), so they appear in the
 * feed, search, place pages and the assistant. They do NOT trigger follower alerts, and they are deleted after
 * NEWS_KEEP_DAYS to keep the database small. Readers can report them like any post.
 */

/** All imported stories are "created" by this fixed id (there is no person behind them). */
export const IMPORT_USER_ID = new Types.ObjectId('000000000000000000000001');
export const IMPORT_JOB = 'import_news';
const SUMMARY_MAX = 560;
/** Our article page shows the publisher's excerpt up to this length — an excerpt, not a copy of the article. */
const EXCERPT_MAX = 1000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_BYTES = 300 * 1024;
const USER_AGENT = 'LocalLensNewsBot/1.0 (headline aggregator; links back to the source)';

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers: { get: (n: string) => string | null } }>;

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  /** The publisher's description as given (an excerpt, never the full article): shown on our article page. */
  excerpt: string;
  publishedAt: Date | null;
  image: string | null;
  /** The feed's picture is only a thumbnail: the page's own share image is better. */
  imageSmall: boolean;
}

// ---------- parsing ----------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', cdataPropName: false, processEntities: true, htmlEntities: true });

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v && typeof v === 'object' && '#text' in v ? String((v as { '#text': unknown })['#text']) : '');

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '\u200c', zwj: '\u200d', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', '#8211': '–', '#8212': '—', '#8216': '‘', '#8217': '’', '#8220': '“', '#8221': '”', '#8230': '…',
};
const decodeOnce = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (ENTITIES[e]) return ENTITIES[e];
    const code = e.startsWith('#x') || e.startsWith('#X') ? parseInt(e.slice(2), 16) : e.startsWith('#') ? Number(e.slice(1)) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
/** Some feeds escape their HTML twice (&amp;lt;p&amp;gt;): decode until nothing changes. */
function decodeDeep(s: string): string {
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}
/** Website leftovers some feeds put in the description (CMS field labels, timestamps). */
const NOISE = [/\bDisplay on listing page\b[^.]*?\b(?:Yes|No)\b/gi, /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2}\/\d{1,2}\/\d{4} - \d{1,2}:\d{2}\b/g, /\bThe post .{1,200} appeared first on .{1,80}\.?$/i];

/** Readable text from a feed field: decode, prefer real paragraphs, drop tags and CMS noise. */
export function plainText(html: string): string {
  const decoded = decodeDeep(html).replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ');
  const paragraphs = [...decoded.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map((m) => m[0]);
  let text = (paragraphs.length ? paragraphs.join(' ') : decoded).replace(/<[^>]+>/g, ' ');
  text = decodeDeep(text);
  for (const re of NOISE) text = text.replace(re, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** The summary without copies of the headline (feeds often repeat it, sometimes with an author name in between). */
export function withoutHeadline(summary: string, title: string): string {
  const t = title.trim();
  if (t.length < 8) return summary.trim();
  return summary.split(t).join(' ').replace(/\s+/g, ' ').replace(/^[\s:.\-–—|]+/, '').trim();
}
const MIN_SUMMARY = 30;

/** Cuts at a word boundary and adds an ellipsis. */
export function shorten(s: string, max = SUMMARY_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).trimEnd()}…`;
}

const httpsUrl = (u: string | undefined | null): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * A thumbnail too small to look good on a phone card (≈ 400 px wide). Recognised from the size the feed states, or
 * from the address (CMS "thumbnail/medium" styles, "-300x169." size suffixes, "w-200," parameters).
 */
export function isSmallImage(url: string, width?: number): boolean {
  if (width && width < 600) return true;
  if (/\/styles\/(?:thumbnail|medium|small)\//i.test(url) || /[?&](?:w|width)=(\d{2,3})(?:&|$)/i.test(url)) return true;
  const suffix = /[-_](\d{2,4})x\d{2,4}\.(?:jpe?g|png|webp)(?:\?|$)/i.exec(url) ?? /[/,]w[-_](\d{2,4})[,/]/i.exec(url);
  return !!suffix && Number(suffix[1]) < 600;
}

/** The best picture the item offers: the widest declared one, else the first usable one. */
function pickImage(item: Record<string, unknown>): { url: string; small: boolean } | null {
  const candidates: { url: string; width?: number }[] = [];
  for (const m of [...arr(item['media:content'] as object), ...arr(item['media:thumbnail'] as object)] as Record<string, string>[]) {
    if (m?.['@_url'] && (!m['@_medium'] || m['@_medium'] === 'image') && !/video/.test(m['@_type'] ?? '')) {
      const width = Number(m['@_width']);
      candidates.push({ url: m['@_url'], ...(Number.isFinite(width) && width > 0 ? { width } : {}) });
    }
  }
  for (const e of arr(item.enclosure as object) as Record<string, string>[]) if (e?.['@_url'] && /^image\//.test(e['@_type'] ?? '')) candidates.push({ url: e['@_url'] });
  for (const html of [text(item['content:encoded']), text(item.description)]) {
    const m = /<img[^>]+src=["']([^"']+)["'][^>]*?(?:width=["']?(\d+))?/i.exec(html);
    if (m?.[1]) candidates.push({ url: m[1], ...(m[2] ? { width: Number(m[2]) } : {}) });
  }
  const usable = candidates
    .map((c) => ({ ...c, url: httpsUrl(c.url?.replace(/&amp;/g, '&')) }))
    .filter((c): c is { url: string; width?: number } => !!c.url && !/\.(svg|gif)(\?|$)/i.test(c.url));
  if (!usable.length) return null;
  const best = [...usable].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!;
  const pick = usable.some((c) => c.width) ? best : usable[0]!;
  return { url: pick.url, small: isSmallImage(pick.url, pick.width) };
}

/** RSS 2.0 and Atom. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, Record<string, unknown>>;
  const channel = (doc.rss?.channel ?? doc['rdf:RDF']) as Record<string, unknown> | undefined;
  const raw = channel ? arr(channel.item as object) : arr((doc.feed as Record<string, unknown> | undefined)?.entry as object);
  return (raw as Record<string, unknown>[]).flatMap((it) => {
    const title = plainText(text(it.title));
    const linkField = it.link;
    const link =
      typeof linkField === 'string'
        ? linkField
        : (arr(linkField as object) as Record<string, string>[]).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'] ?? text(linkField);
    const url = httpsUrl(link);
    if (!title || !url) return [];
    // The description/summary only — never content:encoded, which can hold the full article.
    const described = withoutHeadline(plainText(text(it.description) || text(it.summary)), title);
    const summary = shorten(described);
    const date = new Date(text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']));
    const picked = pickImage(it);
    return [{ title: shorten(title, 200), link: url, summary, excerpt: shorten(described, EXCERPT_MAX), publishedAt: Number.isNaN(date.getTime()) ? null : date, image: picked?.url ?? null, imageSmall: picked?.small ?? false }];
  });
}

/** For items without a photo in the feed: the page's own share image (og:image), only on the source's own site. */
/** The page's own short description (what it shows when shared), for feeds that give no usable summary. */
export function findOgDescription(html: string): string | null {
  const m =
    /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i.exec(html);
  const text = m?.[1] ? plainText(m[1]) : '';
  return text.length >= MIN_SUMMARY ? text : null;
}

export function findOgImage(html: string): string | null {
  const m = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i.exec(html);
  return httpsUrl(m?.[1]?.replace(/&amp;/g, '&'));
}

// ---------- placing and filing ----------
const TOPIC_RULES: [string, RegExp][] = [
  ['education', /school|college|exam|student|university|education|పరీక్ష|పాఠశాల|విద్య|కళాశాల|విద్యార్థ/i],
  ['employment', /job|recruit|vacanc|employment|notification for posts|ఉద్యోగ|నోటిఫికేషన్|నియామక/i],
  ['agriculture', /farmer|crop|paddy|agricultur|irrigation|రైతు|పంట|వ్యవసాయ|ధాన్యం/i],
  ['public_safety', /cyclone|flood|rain|accident|fire|police|weather|imd|తుపాను|వరద|వర్ష|ప్రమాద|పోలీస|అల్పపీడన|వాతావరణ/i],
  ['government_announcements', /scheme|pension|government order|collector|minister|cabinet|పథకం|పింఛన్|ప్రభుత్వ|కలెక్టర్|మంత్రి/i],
  ['civic_issues', /road|water supply|drainage|electricity|power cut|municipal|రోడ్డు|తాగునీ|విద్యుత్|మున్సిపల్/i],
];

async function catalog() {
  const [categories, places] = await Promise.all([
    CategoryModel.find({}, { slug: 1 }).lean(),
    LocationModel.find({ level: { $in: ['state', 'district', 'mandal'] } }, { name: 1, aliases: 1, level: 1, ancestorIds: 1 }).lean(),
  ]);
  const bySlug = new Map<string, Types.ObjectId>(categories.map((c) => [c.slug as string, c._id]));
  // Most specific first: a mandal match beats a district match beats the state.
  const order = { mandal: 0, district: 1, state: 2 } as Record<string, number>;
  const named = places
    .flatMap((p) => [p.name?.en, p.name?.te, ...((p as { aliases?: string[] }).aliases ?? [])].filter((n): n is string => !!n && n.length >= 3).map((n) => ({ n, p })))
    .sort((a, b) => (order[a.p.level] ?? 9) - (order[b.p.level] ?? 9) || b.n.length - a.n.length);
  return { bySlug, named, state: places.find((p) => p.level === 'state') ?? null };
}

function placeFor(textToSearch: string, cat: Awaited<ReturnType<typeof catalog>>) {
  const lower = textToSearch.toLowerCase();
  for (const { n, p } of cat.named) {
    if (p.level === 'state') continue;
    const isTelugu = /[ఀ-౿]/.test(n);
    if (isTelugu ? textToSearch.includes(n) : new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) return p;
  }
  return cat.state;
}

function topicFor(textToSearch: string, cat: Awaited<ReturnType<typeof catalog>>) {
  for (const [slug, re] of TOPIC_RULES) if (re.test(textToSearch) && cat.bySlug.has(slug)) return cat.bySlug.get(slug)!;
  return cat.bySlug.get('community_news') ?? [...cat.bySlug.values()][0]!;
}

// ---------- import ----------
async function fetchText(fetcher: FetchLike, url: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > maxBytes) throw new Error('too large');
  return body;
}

export interface ImportResult {
  source: string;
  fetched: number;
  added: number;
  withPhoto: number;
  error: string | null;
}

export async function importSource(source: NewsSource, opts: { fetcher: FetchLike; keepDays: number; logger?: Logger; now?: Date }): Promise<ImportResult> {
  const now = opts.now ?? new Date();
  const result: ImportResult = { source: source.name, fetched: 0, added: 0, withPhoto: 0, error: null };
  let items: FeedItem[];
  try {
    items = parseFeed(await fetchText(opts.fetcher, source.feedUrl, MAX_FEED_BYTES, 20_000));
  } catch (err) {
    result.error = (err as Error).message;
    opts.logger?.warn({ source: source.id, err: result.error }, 'news feed failed');
    return result;
  }
  result.fetched = items.length;
  const cat = await catalog();
  const site = new URL(source.siteUrl).hostname.replace(/^www\./, '');
  const oldest = new Date(now.getTime() - opts.keepDays * 86_400_000);
  let pageLookups = 0;

  for (const item of items.slice(0, 40)) {
    const publishedAt = item.publishedAt && item.publishedAt <= now ? item.publishedAt : now;
    if (publishedAt < oldest) continue;
    const externalId = createHash('sha256').update(item.link.replace(/[?#].*$/, '').replace(/\/$/, '')).digest('hex');
    if (await ArticleModel.exists({ externalId })) continue;

    let image = item.image;
    let summaryText = item.summary.length >= MIN_SUMMARY ? item.summary : '';
    let excerpt = summaryText ? item.excerpt : '';
    // Missing or thumbnail-sized photo, or no usable summary: read the publisher's own share tags (og:image is
    // usually 1200 px wide). Only the publisher's own pages, and a limited number per run.
    if ((!image || item.imageSmall || !summaryText) && pageLookups < 20 && new URL(item.link).hostname.replace(/^www\./, '').endsWith(site)) {
      pageLookups++;
      const head = await fetchText(opts.fetcher, item.link, MAX_PAGE_BYTES * 10, 8_000)
        .then((html) => html.slice(0, MAX_PAGE_BYTES))
        .catch(() => '');
      const og = findOgImage(head);
      if (og && (!image || item.imageSmall)) image = og;
      if (!summaryText) {
        const described = withoutHeadline(findOgDescription(head) ?? '', item.title);
        summaryText = shorten(described);
        excerpt = shorten(described, EXCERPT_MAX);
      }
    }

    const location = placeFor(`${item.title} ${item.summary}`, cat);
    if (!location) continue; // no places set up yet
    const id = new Types.ObjectId();
    const summary = summaryText || item.title;
    try {
      await ArticleModel.create({
        _id: id,
        slug: makeSlug(item.title, id),
        status: 'published',
        revisionCount: 0,
        headline: item.title,
        summary,
        body: excerpt || summary,
        trustLabel: 'external_source',
        language: source.language,
        locationId: location._id,
        locationLineage: [location._id, ...(location.ancestorIds ?? [])],
        categoryId: topicFor(`${item.title} ${item.summary}`, cat),
        sourceType: 'external',
        originalSourceUrl: item.link,
        firstPublishedAt: publishedAt,
        lastUpdatedAt: publishedAt,
        createdBy: IMPORT_USER_ID,
        imageUrl: image,
        externalSource: { name: source.name, url: source.siteUrl, feedId: source.id },
        externalId,
        searchText: `${item.title} ${summary}`,
      });
      result.added++;
      if (image) result.withPhoto++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // a parallel run added it first: fine
    }
  }
  return result;
}

/** Deletes imported stories older than keepDays (and their reports). Our own reporters' posts are never pruned. */
export async function pruneImported(keepDays: number, now = new Date()): Promise<number> {
  const old = await ArticleModel.find({ sourceType: 'external', firstPublishedAt: { $lt: new Date(now.getTime() - keepDays * 86_400_000) } }, { _id: 1 }).lean();
  if (!old.length) return 0;
  const ids = old.map((a) => a._id);
  await ContentReportModel.deleteMany({ articleId: { $in: ids } });
  return (await ArticleModel.deleteMany({ _id: { $in: ids } })).deletedCount;
}

/** Stories imported before the text cleaner improved: re-clean them, or drop them (the next import re-adds them). */
export async function repairImportedText(fetcher?: FetchLike): Promise<{ fixed: number; dropped: number; photos: number }> {
  // Imports are kept a few days only, so checking all of them is cheap.
  const stories = await ArticleModel.find({ sourceType: 'external' }, { summary: 1, headline: 1, body: 1, imageUrl: 1, originalSourceUrl: 1, externalSource: 1 }).limit(5000);
  let photos = 0;
  let lookups = 0;
  for (const a of stories) {
    // Card text: up to ~80 words when the publisher's excerpt (stored as body) is longer than the card text.
    if (a.body && a.body.length > a.summary.length + 20 && a.summary.length < SUMMARY_MAX - 20) {
      a.summary = shorten(a.body);
      await ArticleModel.updateOne({ _id: a._id }, { $set: { summary: a.summary, searchText: `${a.headline} ${a.summary}` } });
    }
    // Thumbnail-sized photo: swap for the page's share image (a few per run, publisher's page only).
    if (fetcher && a.imageUrl && isSmallImage(a.imageUrl) && a.originalSourceUrl && !a.externalSource?.photoChecked && lookups < 40) {
      lookups++;
      const og = await fetchText(fetcher, a.originalSourceUrl, MAX_PAGE_BYTES * 10, 8_000)
        .then((html) => findOgImage(html.slice(0, MAX_PAGE_BYTES)))
        .catch(() => null);
      // Checked once either way, so a page without a bigger picture is not fetched again on every run.
      const better = og && !isSmallImage(og) ? og : null;
      await ArticleModel.updateOne({ _id: a._id }, { $set: { 'externalSource.photoChecked': true, ...(better ? { imageUrl: better } : {}) } });
      if (better) photos++;
    }
  }
  let fixed = 0;
  let dropped = 0;
  for (const a of stories) {
    const clean = shorten(withoutHeadline(plainText(a.summary), a.headline));
    if (clean === a.summary) continue;
    if (clean.length >= MIN_SUMMARY) {
      await ArticleModel.updateOne({ _id: a._id }, { $set: { summary: clean, body: clean, searchText: `${a.headline} ${clean}` } });
      fixed++;
    } else if (a.summary !== a.headline) {
      await ContentReportModel.deleteMany({ articleId: a._id });
      await ArticleModel.deleteOne({ _id: a._id });
      dropped++;
    }
  }
  return { fixed, dropped, photos };
}

export async function importAll(opts: { fetcher: FetchLike; keepDays: number; sources?: NewsSource[]; logger?: Logger }): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const repaired = await repairImportedText(opts.fetcher);
  if (repaired.fixed || repaired.dropped || repaired.photos) opts.logger?.info(repaired, 'repaired imported stories');
  for (const s of (opts.sources ?? NEWS_SOURCES).filter((x) => x.enabled)) results.push(await importSource(s, opts));
  const pruned = await pruneImported(opts.keepDays);
  opts.logger?.info({ results, pruned }, 'news import finished');
  return results;
}

export function configureAggregator(opts: { enabled: boolean; intervalMin: number; keepDays: number; logger: Logger; fetcher?: FetchLike }): void {
  const fetcher = opts.fetcher ?? (fetch as unknown as FetchLike);
  registerJobHandler(IMPORT_JOB, {
    async run() {
      const results = await importAll({ fetcher, keepDays: opts.keepDays, logger: opts.logger });
      // Retry later only if every source failed (e.g. no internet); one broken feed must not block the others.
      if (results.length && results.every((r) => r.error)) throw new Error('all news feeds failed');
    },
  });
  if (!opts.enabled) return;
  registerSweeper('news-import', async () => {
    const slot = Math.floor(Date.now() / (opts.intervalMin * 60_000));
    await enqueue(IMPORT_JOB, {}, { dedupeKey: `news:${slot}`, maxAttempts: 2 });
  });
}

/** Admin: run an import now and see what each source returned. */
export function adminNewsRouter(opts: { keepDays: number; fetcher?: FetchLike; logger: Logger }): Router {
  const r = Router();
  r.use(requireRole('admin'));
  r.get('/news/sources', (_req, res) => {
    res.json({ items: NEWS_SOURCES.map(({ id, name, siteUrl, language, enabled }) => ({ id, name, siteUrl, language, enabled })) });
  });
  r.post('/news/import', async (req, res) => {
    const results = await importAll({ fetcher: opts.fetcher ?? (fetch as unknown as FetchLike), keepDays: opts.keepDays, logger: opts.logger });
    await audit(req, { action: 'news.imported', actorId: currentUser(req)._id, metadata: { results } });
    res.json({ results });
  });
  return r;
}

