# Phase 1 — Foundation & Authentication

Status: **Done (email + password); Docker items not yet verified** · Last updated: 2026-10-10

## Goal
A running, tested foundation: a monorepo, local infrastructure, an Express API with email + password authentication
and role-based authorization, and a Telugu/English React app where people sign up, ask for reporter access and manage
their profile; admins manage users, approve reporters and reset passwords.

> **History (2026-10-10):** Phase 1 first shipped email + password with verification emails, then switched to phone +
> OTP, then — at the product owner's request — settled on **plain email + password with no email or SMS sending**,
> because no email/SMS provider is set up. Verification and self-service reset can return when a provider exists.

## Acceptance criteria — results (2026-10-10)

Automated: **53 API tests + 9 web tests passing**; `typecheck`, `lint` and `build` clean.

**Foundation**
- [x] AC1 `npm install` then `npm test` passes, no Docker required.
- [ ] AC2 `docker compose up -d` starts MongoDB (replica set) and Redis healthy. **Not verified — Docker Desktop was not running.**
- [x] AC3 API refuses to start on missing/invalid configuration (and unsafe production settings).
- [x] AC4 `/healthz` 200; `/readyz` 200 / 503.
- [x] AC5 `X-Request-Id` on every response; standard error shape; 404 for unknown routes.
- [x] AC6 CSP, `nosniff`, `frame-ancestors 'none'`; no `X-Powered-By`; HSTS only in production.
- [x] AC7 `typecheck` and `lint` pass; CI workflow defined — **not yet run on GitHub** (no remote).

**Authentication**
- [x] AC8 Sign-up creates an active `reader` and signs in; only an Argon2id hash is stored; duplicate emails get `409 EMAIL_TAKEN`.
- [x] AC9 Choosing "report news" creates a pending request only; roles cannot be set at sign-up.
- [x] AC10 Sign-in sets an `HttpOnly; SameSite=Lax` cookie; only the token hash is stored.
- [x] AC11 Unknown email and wrong password give the same `401`; suspended accounts get `403` (after a correct password).
- [x] AC12 5 failed sign-ins lock the account for 15 minutes (`429` + `Retry-After`); success resets the counter.
- [x] AC13 Logout and logout-all invalidate sessions server-side.
- [x] AC14 Changing a password needs the current one and signs out other devices.
- [x] AC15 Non-JSON bodies → `415`; foreign/missing `Origin` on unsafe methods → `403 CSRF_REJECTED`.
- [x] AC16 Operator injection and unknown fields → `400`.

**Authorization**
- [x] AC17 Anonymous `401`, non-admin `403` on every admin endpoint.
- [x] AC18 Role changes audited; self-demotion blocked.
- [x] AC19 Suspension revokes sessions immediately; reactivation restores sign-in.
- [x] AC20 Reporter requests: approve adds `reporter`, decline keeps `reader` and lets the user ask again.
- [x] AC21 Admin password reset: one-time temporary password, sessions revoked, must be changed after sign-in; never logged.
- [x] AC22 `admin:promote` and `seed:dev` CLIs work; `seed:dev` refuses non-local databases.

**Web**
- [x] AC23 Sign-up, sign-in, account page (profile, change password, reporter request) and admin page (approvals, password reset) — checked in the browser.
- [x] AC24 Every UI string exists in Telugu and English (key and placeholder parity enforced by tests).
- [x] AC25 No horizontal overflow at 360 px.

## Known gaps / follow-ups
- Docker Compose stack and production image build have not been run on this machine yet.
- Telugu copy is a draft awaiting native-speaker review (pilot assumption P10).
- Second factor for editors/admins before public launch.
