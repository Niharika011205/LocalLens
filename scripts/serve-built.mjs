#!/usr/bin/env node
/**
 * Runs the production build (API + built web app on one origin) locally, against the standalone dev database.
 * Used to test what only exists in production builds: the service worker / installable app, caching headers.
 *   npm run build && node scripts/serve-built.mjs     → http://localhost:4300
 * Behind a temporary public https link (e.g. `cloudflared tunnel --url http://localhost:4300`), set PUBLIC_URL to that
 * address (or write it in .public-url) so sign-in and posting accept requests from it.
 */
import { readFileSync } from 'node:fs';
// Same settings as the dev server (e.g. the AI service URL and token) …
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // no .env: defaults below are enough to run without AI
}
let publicUrl = process.env.PUBLIC_URL;
try {
  publicUrl ||= readFileSync(new URL('../.public-url', import.meta.url), 'utf8').trim();
} catch {
  // no public link
}
// … but always this local setup: its own port and origin, the standalone database, no second job worker.
Object.assign(process.env, {
  NODE_ENV: 'development',
  API_PORT: '4300',
  APP_ORIGIN: 'http://localhost:4300',
  MONGODB_URI: 'mongodb://127.0.0.1:27019/locallens',
  RATE_LIMIT_STORE: 'memory',
  COOKIE_SECURE: 'false',
  STATIC_DIR: new URL('../apps/web/dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  JOBS_WORKER: 'false', // the dev server's worker already imports news and runs jobs
  NEWS_IMPORT: 'false',
});
if (publicUrl) {
  // Reached through the https tunnel: that address is the app's origin; the tunnel is one trusted proxy hop.
  Object.assign(process.env, { APP_ORIGIN: new URL(publicUrl).origin, COOKIE_SECURE: 'true', TRUST_PROXY: '1' });
}
await import('../apps/api/dist/server.js');
