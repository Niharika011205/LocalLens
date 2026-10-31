# LocalLens AI — Security Model

Status: **Finalized for the initial release** · Last updated: 2026-10-10 · Checklist baseline: OWASP ASVS Level 2

## 1. Assets and threats

| Asset | Main threats | Primary controls |
|---|---|---|
| User accounts | Credential stuffing, password guessing, session theft | Argon2id, per-IP and per-account limits, generic errors, httpOnly cookies, session revocation |
| Unpublished submissions | IDOR (reading others' submissions), leaks via public endpoints | Policy layer with ownership + scope checks; public reads only from `articles` |
| Publication authority | Privilege escalation, compromised publisher account, AI auto-publishing | RBAC + scopes, publisher allow-lists, no AI write access, audit log |
| Reporter identity & location | Doxxing via data or photo metadata | Minimal PII, EXIF/GPS stripping (Phase 4 uploads), optional pseudonymous bylines |
| Platform integrity | Coordinated false reports, prompt injection (Phase 4) | Volume never publishes; AI output is advisory and schema-validated |
| Availability & cost | Request floods, LLM cost abuse | Rate limits per IP and per account; AI calls only on submissions |

## 2. Authentication

- **Email + password, no email delivery.** The app sends no email, so addresses are not verified: the email is a login
  name, not proof of identity. Trust comes from roles, which only admins grant.
- **Passwords:** Argon2id (`@node-rs/argon2`), memory 19 MiB, iterations 2, parallelism 1 — the OWASP Password Storage
  Cheat Sheet minimum. Length 8–128; no composition rules (NIST SP 800-63B). The maximum stops very long inputs being used
  to make the server hash expensively.
- **Sign-in:** the same error for unknown email and wrong password; unknown emails are checked against a dummy hash so
  timing is similar. After 5 failures an account is locked for 15 minutes (per-email limiter, keyed by a hash of the email).
- **Enumeration trade-off:** sign-up says "email already registered" (`409 EMAIL_TAKEN`). Without email delivery this
  cannot be hidden; it is mitigated by the per-IP sign-up limit.
- **Recovery:** no self-service reset (it would need email or SMS). An admin issues a one-time temporary password
  (12 characters from a CSPRNG, shown once, `Cache-Control: no-store`, never logged); all the user's sessions are revoked
  and they must change it after signing in. Changing a password signs out the user's other devices.
- **Sessions:** 256-bit random token in cookie `ll_session` — `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`.
  Server stores only the hash. Absolute lifetime 30 days, idle timeout 7 days. A new session is created on every sign-in
  (prevents session fixation). Suspension and "sign out everywhere" delete all of the user's sessions.
- **Self-service roles are limited to asking.** Sign-up can request reporter access; only an admin can grant it.
  Editor, senior editor, publisher and admin are never self-service.
- **Deferred:** email verification and self-service reset (need an email provider), phone OTP (needs an SMS provider and
  DLT registration — tried in Phase 1 and removed), Google OAuth, a second factor for staff, breached-password checks.

## 3. Authorization

- Roles: `reader, reporter, editor, senior_editor, publisher, admin`. A user may hold several.
- Three layers, checked in this order:
  1. **Authentication** — `requireAuth` middleware (valid session, account active).
  2. **Role** — `requireRole(...roles)` middleware.
  3. **Object policy** — functions in `policy.ts` (e.g. `canViewSubmission(user, submission)`: owner, or editor whose
     scope contains the submission's location). Routes call these explicitly; tests cover each one with a
     "different user, same role" case, which is how IDOR bugs are caught.
- Suspended users are rejected on every request, even with a live session (status is checked when the session loads).
- Admins cannot remove their own `admin` role or suspend themselves, so the system cannot be left without an admin by accident.
- First admin: `npm run admin:promote -- you@example.com` (CLI with direct DB access; there is no HTTP path to become admin).

## 4. Web security

| Threat | Control |
|---|---|
| CSRF | `SameSite=Lax` cookies **and** an `Origin` check on all unsafe methods **and** JSON-only bodies (HTML forms cannot send `application/json` cross-site without a CORS preflight) |
| XSS | React escapes output; strict Content-Security-Policy via helmet (`default-src 'self'`, no inline scripts); article bodies stored as plain text/markdown and rendered without `dangerouslySetInnerHTML` |
| Clickjacking | `frame-ancestors 'none'` |
| MIME sniffing / referrer leaks | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` |
| NoSQL injection | All input parsed by Zod into exact types (a string field cannot become `{ "$gt": "" }`); Mongoose `strictQuery` drops unknown filter fields; user text used in a regex is escaped |
| Mass assignment | Zod schemas list allowed fields; unknown fields are rejected (`.strict()`) |
| Large bodies | JSON body limit 100 KB |
| Information leaks | Errors return a code and generic message; stack traces only in logs; `X-Powered-By` disabled |

## 5. Rate limiting
`rate-limiter-flexible` with Redis in deployed environments (limits are shared by all API instances) and in-memory in
tests and stand-alone dev. If Redis fails: **sign-in and sign-up fail closed** (`503`), general reads fail open. Limits are
listed in `04-api-contracts.md`. Behind a reverse proxy, `TRUST_PROXY` must be set so the real client IP is used.

## 6. Secrets & configuration
- All configuration through environment variables, validated at startup with Zod; the process refuses to start with
  invalid configuration (e.g. `COOKIE_SECURE=false` in production).
- `.env` is git-ignored; `.env.example` documents every variable with safe placeholder values.
- No secrets in logs: pino redacts `password`, `token`, `cookie` and `authorization` fields.

## 7. Audit logging
Events: registration, sign-in success/failure, logout, password change, admin password reset, reporter
requested/approved/rejected, role change, suspension/reactivation — and in Phase 3 every editorial transition. Audit
records hold IDs, IP and request ID; never passwords or tokens. In production the app's MongoDB user gets only
`insert` and `find` on `audit_events`.

## 8. Supply chain & CI
`npm ci` with a committed lockfile; `npm audit --audit-level=high` in CI; Dependabot (or Renovate) for updates;
Docker images based on official slim images, run as a non-root user.

## 9. AI components (Phases 4–5)
- **Isolation:** the AI service has no database credentials and accepts only requests with the shared
  `X-Service-Token` (32+ random characters, compared in constant time). It is not exposed publicly.
- **SSRF:** reporter-supplied links are fetched by a custom fetcher that resolves DNS itself, connects only to the
  validated *public* IP (no DNS rebinding), re-validates every redirect (max 3), caps size and time, and honours
  robots.txt. Tests cover private, loopback, link-local and metadata addresses.
- **Prompt injection:** submission and source text are wrapped as data; the model's output is validated against a
  schema, every quoted excerpt must appear verbatim in the fetched text, references to passages we did not retrieve are
  dropped, and the overall assessment is computed in code from the surviving evidence. The AI can only *raise*
  scrutiny (mark high risk); it can never approve, publish or lower risk.
- **Assistant:** answers only from articles the API retrieved; citations are re-checked; no answer is shown without one.
  Questions are not stored (only a hash for the 24 h cache) and are not logged. Signed-in users only, 20 per hour.

## 10. Alerts, accountability and admin tools (Phases 6–7)
- Alerts are in-app only (no SMS/email: nothing sent to third parties), contain only an article reference, and expire
  after 90 days.
- Track records are computed from editorial decisions and shown in full to the reporter. They change queue order only
  (a head start for consistently accurate reporters); they never block or hide anyone.
- Appeals are decided by a senior editor **other than** the one who rejected (enforced, tested); outcomes are in the
  reporter-visible timeline and the audit log.
- The audit viewer is admin-only, read-only, and filters by exact action or prefix (validated, no regex injection).

## 11. Security review — Phase 8 (October 2026)
- `npm audit --omit=dev` found **body-parser** (high, DoS via compressed body), **qs** (moderate, DoS) and **zod <4.6.6**
  (high, memory exhaustion on oversized collections). Fixed: body-parser 2.4.0, patched qs, and **zod upgraded 3 → 4.6.7**
  across contracts, API and web (two code changes; all tests pass). Result: 0 known vulnerabilities.
- `pip-audit` on the AI service requirements: no known vulnerabilities.
- Reviewed: every state-changing route requires a session + Origin check; every editorial route checks role and
  editor scope; object-level checks return 404 for other users' submissions; all input parsed with strict schemas;
  JSON bodies capped at 100 KB; no raw user input reaches a regex or `$where`.
- Test isolation fix: each test file now uses its own database name (a rare cross-file wipe showed up once under load).

## 12. Two-step sign-in (added after Phase 8)
- TOTP (RFC 6238, the standard authenticator-app codes; verified against the RFC test vectors and against an
  independent Python implementation). No SMS: no cost, no SIM-swap risk, no phone numbers stored.
- Required for staff (editor, senior editor, publisher, admin) when `MFA_ENFORCE=true` — **mandatory in production**
  (the API refuses to start otherwise). Until it is on, staff routes answer `403 MFA_SETUP_REQUIRED`; reading and the
  account page still work so they can set it up. Staff cannot turn it off while it is enforced.
- Setup needs the current password; the secret activates only after a correct first code; other devices are signed out.
- Secrets are encrypted at rest (AES-256-GCM, key `MFA_ENCRYPTION_KEY`); ten one-time recovery codes are stored only as
  SHA-256 hashes and shown once.
- Sign-in: a correct password yields a 5-minute challenge in an httpOnly cookie scoped to `/api/v1/auth`, good for 5
  attempts, then deleted. The session is created only after a correct code. Codes cannot be replayed (the last used
  time step is stored and updated with a compare-and-set).
- Lost phone: another admin resets it after confirming the person's identity out of band; this signs them out
  everywhere and is audited. Nobody can reset their own.

## 13. Known limitations (accepted for the pilot)
- Unverified emails: someone can register with an address they do not own. Harmless for reading; reporter and higher
  roles require an admin, who should know the person.
- Password recovery depends on an admin; this needs a support process during the pilot.
- Small local models (llama3.2) extract claims well but judge support loosely (seen in the end-to-end test: a claim
  marked "supported" by a related but not confirming excerpt). The excerpts themselves are always genuine. Use Claude in
  production and keep the analysis advisory.
- Docker images (API and AI service) are defined and built in CI but were not built on the development machine
  (Docker Desktop not running).
