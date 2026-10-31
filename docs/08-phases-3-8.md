# LocalLens AI — Phases 3 to 8: decisions and results

What each phase delivered, the decisions that matter, and what was **actually verified** (tests and the running app).
Counts are from the final run on 29 Oct 2026: API 170 tests, web 36, AI service 28, all passing; typecheck and lint clean.

> The master specification was truncated partway through Feature D (AI News Assistant). Phases 6–8 follow the product
> vision in the part that was received; anything beyond it should be checked against the full specification.

## Phase 3 — Newsroom
**Delivered:** reporter drafts and submissions with versioned history; editorial queue (high risk first, then oldest);
claim / request info / return / reject / publish with atomic state transitions and an append-only timeline; deterministic
Telugu/English risk screen (high risk needs a senior editor to publish); duplicate detection (same district, ±7 days);
publisher organisations with the hybrid policy (direct publish only when every check passes, otherwise review with
reasons); reader content reports and a moderation queue; editor location scopes.

**Verified:** `newsroom`, `publishers` test files; in the browser a reporter submitted, an editor claimed and published.

## Phase 4 — AI verification
**Decision:** a MongoDB-backed job queue instead of Redis + BullMQ (architecture D7): no outbox gap, one fewer service.

**Delivered:** job worker with leases, backoff with jitter, breakers, dedupe and sweepers; AI service (FastAPI) with
SSRF-safe fetching, claim extraction, per-claim assessment, verbatim-excerpt guardrails and a recommendation that can
only add scrutiny; editor panel showing claims, sources, excerpts and the advisory note; retry.

**Verified:** `verification` tests (fake AI server: success, transient retry, permanent failure → manual review, stale
versions skipped, risk only raised); AI service tests. **End to end with real Ollama (llama3.2):** a report citing
Wikipedia's Guntur page was fetched, 3 claims extracted, 4 excerpts kept (all genuinely in the page), 4.6 minutes on CPU.
Found and fixed: the same excerpt cited twice counted as two pieces of evidence (now deduplicated, tested). Observed
limitation: the small model judged one claim "supported" from related-but-not-confirming text — the analysis stays
advisory, and Claude is the production model.

## Phase 5 — AI news assistant
**Delivered:** `POST /assistant/ask` — retrieval from published articles (the article being read, plus text search,
optionally limited to a place with the feed's inside/above rule), corrections included, citations re-checked, no model
call when nothing matches, 24 h cache keyed by question and article revisions, 20 questions/hour/user, sign-in required
(cost control). Web: "Ask about this news" on article pages, an Ask page (optionally per place), Telugu/English answers
and a simple-Telugu option, sources and an AI disclaimer.

**Verified:** 8 API tests, 3 UI tests. **End to end with Ollama:** the Telugu question "గుంటూరు జిల్లా ప్రధాన కేంద్రం ఏది?"
answered correctly in Telugu in 20 s with a link to the source article; the repeat was served from cache in 44 ms; an
off-topic question returned "not enough information" in 20 ms without calling the model.

## Phase 6 — Deadlines and alerts
**Delivered:** deadlines on articles (editors, publishers, and at publish time for reporter stories); changing a
published deadline must be a correction; upcoming-deadlines page and a card on every place page; in-app alerts for new
articles in followed places/topics, corrections and retractions (to savers and everyone alerted), and a reminder 3 days
before a deadline. Fan-out runs in jobs with a unique key per alert, so retries never duplicate. Alerts expire after 90 days.

**Verified:** 7 API tests, 2 UI tests. In the running app: a reader following Guntur got the alert within 6 s of an
editor publishing; the Guntur page showed "31 Oct 2026 · 2 days left"; the nav showed the unread badge.

## Phase 7 — Accountability and operations
**Delivered:** reporter track record (counts of editorial outcomes over 180 days, rules shown to the reporter; "trusted"
reporters get a 12-hour queue head start; nobody is pushed back); appeals (once, within 14 days, decided by a different
senior editor; overturned → back to review); admin Operations page (queue health, articles, jobs, failed jobs with retry,
AI status); audit log viewer with action/prefix filters.

**Verified:** 6 API tests (head start reorders the queue; needs-support does not penalise; appeal rules incl. the
independence check and the 14-day window; ops counts; job retry; audit paging/filters), 3 UI tests. The Operations page
rendered real data from the running app.

## Phase 8 — Hardening
- **Security review** (see security model §11): fixed three vulnerable dependencies (incl. zod 3 → 4.6.7); 0 known
  vulnerabilities in npm and Python production dependencies.
- **Load test** (`scripts/load-test.mjs`): 20 concurrent readers for 30 s against the dev build on a laptop — 270 req/s,
  p95 109 ms, 0 errors (target p95 < 300 ms). With the default limit, the per-IP rate limiter correctly turned 98% of the
  traffic into fast 429s.
- **Operations:** runbooks, backups and restore drill in `09-operations.md`; configurable global rate limit.
- **Containers:** AI service Dockerfile and compose service; CI builds both images and runs the Python tests and audit.
  **Not verified locally:** Docker Desktop was not running, so the images were not built on this machine.
- **Test reliability:** isolated test databases per file (fixes a rare cross-file wipe seen once).

## After Phase 8 — two-step sign-in for staff
**Delivered:** authenticator-app codes (TOTP) with QR setup, recovery codes, replay protection, encrypted secrets,
a 5-minute/5-attempt sign-in challenge, enforcement for staff (`MFA_ENFORCE`, mandatory in production), and admin reset.
**Verified:** 9 API tests (incl. RFC 6238 vectors, replay, lockout, recovery code once, enforcement, admin reset),
2 UI tests (code step; expiry returns to the password step — this test caught a wrong "incorrect password" message,
fixed). End to end against the running API with codes computed by Python's own HMAC: password alone → 401, replayed
code refused, next code signs in, turning it off works.

## Short-news posting (news-card feed)
**Delivered:** the home page is a card feed — one story per screen with photo, headline, ~60-word summary, place,
label, Read full story, Share and Report. Reporters post from **Post news** (photo, headline, short text, place, topic)
and it is live at once, labelled "Reporter post — not checked by editors". Sign-up option "I want to post news" gives
reporter access immediately (`REPORTER_SELF_SIGNUP`, default on).
- **Automatic removal:** when `REPORTS_TO_REMOVE` (default 10) *different* signed-in readers report a reporter post, it
  disappears for everyone at once, photo included. It is hidden, not destroyed, so an editor can restore it if a group
  reported true news (their reports then stop counting). Authors cannot report their own posts; one report per person.
  Editor-checked articles are never auto-removed — their reports go to the editors' queue.
- **Safety net:** posts that trip the risk screen (violence, communal tension, accusations…) wait for an editor.
- **Photos:** resized on the phone before upload (saves mobile data), then decoded and re-encoded on the server
  (max 1280 px WebP, max 8 MB in, decompression-bomb limit) with **all metadata removed** (GPS location). Stored in
  MongoDB GridFS (no extra service; included in backups). Served only while the post is public.
- Authors see their posts' status and report counts in **My posts** and can delete them. Posting is rate-limited
  (20 per hour per reporter).

**Verified:** 7 API tests (live post with cleaned photo; non-photo/oversized/HTML rejected; 10th report removes and
the photo goes too; editor-checked articles are not removed; restore resets the count; risky posts held; author delete;
approval mode), 2 UI tests. Live: a 2400×1600 JPEG with owner/GPS text was served as a 1280×853 WebP with no metadata,
and appeared at the top of the card feed. Found and fixed during the check: the phone layout cut off the card's
buttons, and the report reasons were squeezed inside the card (now a bottom sheet); the cards also lacked the
"corrected" note (a test caught it). Security: `sharp` 0.34 had high-severity libvips advisories — upgraded to 0.35.5.

## Real news from other sites, and Cloudinary photos
**Delivered:** headlines from Andhra Pradesh news feeds — The Hindu (AP, Vijayawada, Visakhapatnam), The New Indian Express AP, TV9 Telugu AP, NTV Telugu AP, 10TV AP, ABP Desam AP, Asianet News Telugu AP, BIG TV AP, Sakshi (Telugu360 available but off: mostly film news) —
`modules/aggregator/sources.ts`, each checked: feed works, items carry photos, photos load from other sites). Every
20 minutes a background job takes each item's headline, the feed's own short summary (≤ ~60 words), the publisher's
photo (feed image, or the page's og:image for a few items without one, publisher's own site only), the time, and a
link back. The full article is never copied: the card says the site's name and offers "Read on <site> ↗". Imports are
filed by place (a district or mandal named in the text, otherwise the state) and topic (keyword rules), never alert
followers, can be reported like any post, and are deleted after 7 days. Admins: `POST /admin/news/import` runs it now.
Reporters' photos go to **Cloudinary** when `CLOUDINARY_URL` is set (cleaned of metadata first; delivered with
`f_auto,q_auto,w_1280`; deleted from Cloudinary when the author deletes the post or an editor keeps it removed),
otherwise to MongoDB as before. The landing page is now always at "/", the news at /news.

**Verified:** 8 API tests (RSS/Atom parsing, photo picking, og:image fallback, no full text, de-duplication, place and
topic filing, broken feed isolated, pruning, reports, admin import, CSP, Cloudinary upload/delete with a fake
uploader, Cloudinary outage → clear retry message) and 1 UI test. **Live:** the feed held 311 imported/posted stories (300 with photos) from 8 outlets after two runs; the browser shows a
"New stories" button when fresher news arrives (checked every 2 minutes) and "Today/Yesterday" times. Earlier: one import added 120 stories (117 with
photos); the 50 newest in the feed: 47 with photos, from all four sites plus our reporters; all photos loaded in the
browser. Not verified: a real Cloudinary upload (needs your account's CLOUDINARY_URL).

## Installable app (PWA) and full feature check — 30 Oct 2026
**Installable app:** web manifest (name, icons incl. maskable, standalone, start at /news), service worker
(`apps/web/public/sw.js`: app code cache-first, pages network-first with an offline page, **API never cached**),
"Install the app" button (Android/desktop prompt; iPhone Add-to-Home-Screen steps). Verified on the production build
(`node scripts/serve-built.mjs`, port 4300): worker active and controlling, caches hold only code/fonts/icons/offline page.

**Full feature check (production build, real browser):** visitor pages, sign-up (reader), sign out, wrong password,
save, follow, report sheet, Ask AI (real llama3.2: correct, cited, 27 s), post with photo through the form (photo
cleaned, top of feed, follower alerted once), My posts, delete, every editor/admin page, share sheet, alerts.
**Found and fixed:** imported text with raw HTML (double-escaped ABP Desam) and CMS junk (Sakshi); story text shown
twice; imported headlines alerting followers via the repair sweeper (and old wrong alerts removed); article pages served
a stale build after a rebuild (template now re-read; og:image added to share previews); Share did nothing over plain
http (now a share sheet: WhatsApp/Telegram/Facebook/X/copy with fallback); thumbnail-sized photos (now the page's large
share image); "read on site" removed — stories open on LocalLens with a source credit (publishers' excerpts only:
full articles are copyrighted); cards now show ~80 words with the photo in its natural shape.

## Posting rules and villages — 30 Oct 2026
- **Every post goes live at once.** The "waiting for an editor" hold for sensitive words is gone. The only automatic
  removal is 10 readers' reports. Editors can still restore a post removed by unfair reports.
- **Villages from OpenStreetMap:** Chittoor and Tirupati districts (63 mandals, 4,589 villages and towns, about 25% with Telugu names). See [data-sources/locations-osm.md](data-sources/locations-osm.md).

## Open items before a public launch
- Turn on `MFA_ENFORCE` (production does automatically) and have each staff member enrol; a password-recovery support process.
- Native-speaker review of the Telugu interface text (pilot assumption P10).
- Import the verified LGD dataset for Guntur's mandals and villages (`npm run locations:import`).
- Build and run the Docker images; first restore drill on the real backup target.
