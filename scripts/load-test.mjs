#!/usr/bin/env node
/**
 * Read-path load test for LocalLens (no dependencies; Node 22+).
 *
 *   node scripts/load-test.mjs [baseUrl] [--concurrency 20] [--seconds 30]
 *
 * Hits the public pages real readers hit most: the feed, an article, search, place search and deadlines.
 * It never writes. Run it against a local or staging instance, never production without warning the team.
 * The API limits each IP to RATE_LIMIT_GLOBAL_PER_MIN requests a minute (default 300): from one machine you will
 * mostly measure 429s unless the target runs with a higher limit, e.g. RATE_LIMIT_GLOBAL_PER_MIN=100000.
 *
 * Pass criteria (pilot target, see docs/09-operations.md): p95 < 300 ms and < 1% errors at 20 concurrent readers.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:4100').replace(/\/$/, '');
const concurrency = flag('concurrency', 20);
const seconds = flag('seconds', 30);

async function get(path) {
  const started = performance.now();
  try {
    const res = await fetch(base + path, { headers: { Accept: 'application/json' } });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - started };
  } catch {
    return { status: 0, ms: performance.now() - started };
  }
}

// Discover real ids so requests look like real reading, not 404s.
const feed = await (await fetch(`${base}/api/v1/articles?limit=20`)).json().catch(() => ({ items: [] }));
const slugs = feed.items?.map((a) => a.slug) ?? [];
const places = [...new Set(feed.items?.map((a) => a.location.id) ?? [])];
if (!slugs.length) console.warn('No published articles found: article requests are skipped.');

const routes = {
  feed: () => `/api/v1/articles?limit=20`,
  placeFeed: () => (places.length ? `/api/v1/articles?limit=20&locationId=${places[Math.floor(Math.random() * places.length)]}` : null),
  article: () => (slugs.length ? `/api/v1/articles/${slugs[Math.floor(Math.random() * slugs.length)]}` : null),
  search: () => `/api/v1/articles/search?q=${['road', 'water', 'pension', 'school', 'గుంటూరు'][Math.floor(Math.random() * 5)]}`,
  placeSearch: () => `/api/v1/locations/search?q=${['gun', 'ten', 'గుం'][Math.floor(Math.random() * 3)]}`,
  deadlines: () => `/api/v1/articles/deadlines`,
};
const names = Object.keys(routes);
const results = Object.fromEntries(names.map((n) => [n, []]));

console.log(`Load test: ${base}, ${concurrency} concurrent readers for ${seconds}s`);
const deadline = Date.now() + seconds * 1000;
await Promise.all(
  Array.from({ length: concurrency }, async (_, worker) => {
    let i = worker;
    while (Date.now() < deadline) {
      const name = names[i++ % names.length];
      const path = encodeURI(routes[name]() ?? '');
      if (path) results[name].push(await get(path));
    }
  }),
);

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
let total = 0;
let errors = 0;
let limited = 0;
const all = [];
const rows = names.map((name) => {
  const r = results[name];
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  all.push(...ms);
  const err = r.filter((x) => x.status === 0 || x.status >= 500).length;
  const rl = r.filter((x) => x.status === 429).length;
  total += r.length;
  errors += err;
  limited += rl;
  return { route: name, requests: r.length, p50: pct(ms, 50).toFixed(0), p95: pct(ms, 95).toFixed(0), p99: pct(ms, 99).toFixed(0), errors: err, '429': rl };
});
console.table(rows);
all.sort((a, b) => a - b);
const p95 = pct(all, 95);
const errorRate = total ? errors / total : 1;
console.log(`Total ${total} requests, ${(total / seconds).toFixed(1)} req/s, p95 ${p95.toFixed(0)} ms, errors ${(errorRate * 100).toFixed(2)}%, rate-limited ${limited}`);
if (limited > total * 0.05) {
  console.log('INCONCLUSIVE: most requests were rate-limited (the per-IP limit works), so this did not measure throughput. Run the target with RATE_LIMIT_GLOBAL_PER_MIN=100000.');
  process.exit(2);
}
const pass = p95 < 300 && errorRate < 0.01;
console.log(pass ? 'PASS (p95 < 300 ms, errors < 1%)' : 'FAIL (target: p95 < 300 ms, errors < 1%)');
process.exit(pass ? 0 : 1);
