# LocalLens AI — Operations and runbooks

For whoever runs the pilot. Everything here uses tools already in the stack.

## 1. What "healthy" looks like
Check **Admin → Operations** (`/admin/ops`, refreshes every 30 s):

| Signal | Healthy | Act when |
|---|---|---|
| Oldest report waiting | < 24 h | > 24 h: tell the editors; check editor scopes cover every place |
| High-risk reports waiting | 0–few | Growing: a senior editor must review (only they can publish these) |
| Failed jobs | none | Any: see §3.3 |
| "Paused after repeated failures" | not shown | Shown: see §3.1 |
| Open reader reports | handled daily | Older than 2 days |

Probes for the load balancer / uptime checker: `GET /healthz` (process up) and `GET /readyz` (database reachable).

## 2. Backups and restore
**What to back up:** the MongoDB database only. The API and AI service are stateless; Redis holds only rate-limit
counters (losing it is harmless).

**Managed MongoDB (recommended for the pilot):** turn on continuous backup / daily snapshots with 7–30 days retention.

**Self-hosted (Docker Compose):**
```bash
docker compose exec -T mongo mongodump --archive --gzip --db locallens > backup-$(date +%F).archive.gz
```
Store the file off the server (encrypted object storage). Keep 14 daily + 8 weekly copies.

**Restore** (into an empty database; never on top of production without a decision to do so):
```bash
docker compose exec -T mongo mongorestore --archive --gzip --drop --nsInclude 'locallens.*' < backup-2026-10-29.archive.gz
```
Then start the API: it rebuilds indexes and backfills new fields at startup.

**Restore drill (monthly, 15 minutes):** restore the latest backup into a scratch database, start an API against it
(`MONGODB_URI=...`), check `/readyz`, sign in as an admin, open the Operations page and one article. Record the date and
how long it took. A backup that has never been restored is not a backup.

**Data kept on purpose:** articles and their revisions (public record), submissions and editorial events (accountability),
audit events. **Expiring automatically:** sessions (30 days), alerts (90 days), assistant answer cache (24 hours).

## 3. Incidents

### 3.1 AI service or model down
*Symptoms:* "AI unavailable — review manually" on submissions; assistant answers "not available"; Operations shows
`verify_submission` failures or the breaker paused.
*Impact:* none on reading or publishing — editors review without AI.
1. `GET http://<ai-host>:4200/healthz` from the API host. If down, restart the `ai` container.
2. Ollama: `ollama list` and `curl http://127.0.0.1:11434/api/tags`. Claude: check the API key and the provider status.
3. After the fix, failed analyses can be retried per submission ("Run the analysis again") or from Operations → Retry.

### 3.2 Review queue backing up
1. Operations → oldest waiting and high-risk counts. 2. Check editors' scopes (Admin → Users) — a place with no editor
gets no reviews. 3. Ask a senior editor to clear high-risk items.

### 3.3 Failed jobs
Each failed job shows its last error. Fix the cause first (e.g. AI service down), then **Retry**. Jobs are idempotent:
retrying a notification or analysis never duplicates alerts or reports.

### 3.4 Suspected account compromise (editor/admin)
1. Admin → Users → **Suspend** (ends all their sessions immediately). 2. Audit log → filter by the user's actions
(`actorId`) for the last days; check publications, role changes, password resets. 3. Correct or retract anything
published improperly (with public notes). 4. Reset their password (temporary password, must be changed at sign-in),
then reactivate.

### 3.4b Lost phone (two-step sign-in)
1. Confirm who the person is **out of band** (a call to a known number, or in person) — never on the strength of a
   message alone. 2. Admin → Users → **Reset two-step sign-in** (another admin must do it for an admin). 3. They sign in
   with their password and set it up again on the Account page. Everything is in the audit log (`admin.mfa_reset`).
Keep `MFA_ENCRYPTION_KEY` with the other secrets: losing it means every staff member must re-enrol.

### 3.5 Legal or safety takedown
- Needs checking: **Unpublish** (editor) — the article disappears from all public pages and alerts; reversible.
- Wrong and must be withdrawn publicly: **Retract** (senior editor) with a public note — the URL stays with the notice,
  the text is removed, readers who saved it or were alerted get a "withdrawn" alert.
- Record the request reference in the note or audit trail. Do not delete documents: the history is the accountability.

### 3.6 Traffic spike or abuse
The per-IP limit (`RATE_LIMIT_GLOBAL_PER_MIN`, default 300) returns fast 429s. If many real readers share one IP (a
college or mobile carrier NAT), raise it; for abuse, block at the reverse proxy. Login and sign-up have their own
stricter limits and fail closed if Redis is down.

## 4. Load test
```bash
node scripts/load-test.mjs https://staging.example --concurrency 20 --seconds 30
```
Read-only. Pass = p95 < 300 ms and < 1% errors. If most responses are 429 the result is reported as inconclusive: run
the target with `RATE_LIMIT_GLOBAL_PER_MIN=100000` for the test and restore it afterwards.
Baseline (29 Oct 2026, dev build on a laptop): 270 req/s, p95 109 ms, 0 errors.

## 5. Deploy and roll back
1. CI must be green (lint, typecheck, tests, dependency audits, both Docker images).
2. Back up (or confirm last night's snapshot).
3. Deploy the new images; the API runs index builds and small backfills at startup — watch `/readyz`.
4. Smoke test: home page, one article, sign in, Operations page.
5. Roll back = deploy the previous image tags. Schema changes are additive (new optional fields, new collections), so
   the previous version keeps working on the same database.

## 6. Secrets
`AI_SERVICE_TOKEN` (shared by API and AI service, 32+ random characters), `ANTHROPIC_API_KEY` (AI service only), database
and Redis URLs. Rotate the service token by setting the new value on both services and restarting them together.
Never commit `.env`; never paste secrets into tickets or chat.
