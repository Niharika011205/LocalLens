# LocalLens AI — API Contracts

Status: **Phase 1 implemented; Phase 2–3 finalized as design** · Last updated: 2026-10-10

Request/response schemas live in code at `packages/contracts/src` (Zod). This document is the human-readable summary;
when they disagree, the code is right and this document has a bug.

## Conventions
- Base path `/api/v1`. JSON only: requests with a body must send `Content-Type: application/json`.
- Authentication: `ll_session` cookie (httpOnly). No bearer tokens for browser clients.
- State-changing requests (`POST/PUT/PATCH/DELETE`) must carry an `Origin` header matching `APP_ORIGIN` (CSRF defence).
- Every response has `X-Request-Id`.
- Errors always have this shape:
  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "Human-readable text", "details": [], "requestId": "…" } }
  ```
- Error codes: `VALIDATION_FAILED` 400 · `UNAUTHENTICATED` 401 · `ACCOUNT_SUSPENDED` 403 · `FORBIDDEN` 403 ·
  `CSRF_REJECTED` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_MEDIA_TYPE` 415 ·
  `EMAIL_TAKEN` 409 · `RATE_LIMITED` 429 (with `Retry-After`) · `INTERNAL` 500 · `SERVICE_UNAVAILABLE` 503.
- Emails are trimmed and lowercased before use.
- Lists use keyset pagination: `?limit=20&cursor=<opaque>` → `{ items: [...], nextCursor: string | null }`.

### `PublicUser`
```json
{ "id": "…", "email": "ravi@example.in", "displayName": "Ravi", "preferredLanguage": "te",
  "roles": ["reader"], "status": "active",
  "reporterRequest": { "status": "pending", "requestedAt": "2026-10-10T…Z", "decidedAt": null, "note": null },
  "mustChangePassword": false, "createdAt": "2026-10-10T…Z" }
```

---

## Phase 1 (implemented)

### Health
| Method & path | Auth | Response |
|---|---|---|
| `GET /healthz` | — | `200 { "status": "ok" }` |
| `GET /readyz` | — | `200 { "status": "ready" }` or `503 { "status": "not_ready" }` |

### Auth — `/api/v1/auth`
| Method & path | Body | Success | Notes |
|---|---|---|---|
| `POST /register` | `{ email, password, displayName, preferredLanguage?, requestReporter? }` | `201 { user }` + `Set-Cookie` | Signs in immediately. Creates a `reader`; `requestReporter: true` only creates a pending request. `409 EMAIL_TAKEN`. Password 8–128 chars |
| `POST /login` | `{ email, password }` | `200 { user }` + `Set-Cookie` | `401` with the same message for unknown email or wrong password. `403 ACCOUNT_SUSPENDED` (only after a correct password) |
| `POST /logout` | — | `204` | Idempotent |
| `POST /logout-all` | — | `204` | Requires auth; revokes every session of the user |
| `GET /me` | — | `200 { user }` | `401` if not signed in |

### Profile — `/api/v1/me` (signed in)
| Method & path | Body | Success | Notes |
|---|---|---|---|
| `PATCH /` | `{ displayName?, preferredLanguage? }` | `200 { user }` | Unknown fields (e.g. `roles`) rejected |
| `PUT /password` | `{ currentPassword, newPassword }` | `200 { user }` | Clears `mustChangePassword`; signs out other devices |
| `POST /reporter-request` | — | `200 { user }` | Ask for reporter access. `409` if already a reporter or a request is pending |

### Admin — `/api/v1/admin` (role `admin`)
| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /users` | `?q=&reporterRequest=pending&limit=&cursor=` | `200 { items: PublicUser[], nextCursor }` | `q` matches the start of the email or name (case-insensitive) |
| `POST /users/:id/reset-password` | — | `200 { temporaryPassword }` (`Cache-Control: no-store`) | One-time password; user must change it. Revokes their sessions. Not for your own account |
| `POST /users/:id/reporter-request` | `{ decision: "approve" \| "reject", note? }` | `200 { user }` | Approve adds `reporter`. `409` if no pending request |
| `PUT /users/:id/roles` | `{ roles: Role[] }` | `200 { user }` | Admins cannot remove their own `admin` role (prevents lock-out) |
| `POST /users/:id/suspend` | `{ reason }` | `200 { user }` | Revokes all sessions. Cannot suspend self |
| `POST /users/:id/reactivate` | — | `200 { user }` | |

### Rate limits (Phase 1 defaults; configurable)
| Scope | Limit |
|---|---|
| All API requests, per IP | 300 / minute |
| `register`, per IP | 10 / hour |
| `login`, per IP | 30 / 15 min |
| `login` failures, per email | 5 / 15 min, then locked for 15 min |

---

## Phase 2 (implemented)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /locations?parentId=` · `GET /locations/search?q=` · `GET /locations/:id` | — | Browse and search places |
| `POST /admin/locations` · `PATCH /admin/locations/:id` | admin | Manage the hierarchy |
| `GET /categories` | — | Topics |
| `GET /articles?locationId=&categoryId=&cursor=&limit=` | — | Public feed (inside the place and the areas above it) |
| `GET /articles/search?q=` | — | Search |
| `GET /articles/:slug` | — | Article with public history |
| `GET /me/feed` · `GET/PUT/DELETE /me/follows/:type/:id` · `GET/PUT/DELETE /me/saved/:articleId` | reader | Follows, saved, personal feed |
| `GET/POST /editorial/articles` · `POST /editorial/articles/:id/{revisions,unpublish,republish,retract}` | editor (retract: senior) | Publishing and corrections |

## Phase 3 (implemented)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET/POST /submissions` · `GET/PATCH /submissions/:id` · `POST /submissions/:id/{submit,withdraw}` | reporter (owner) | Drafts, submitting, tracking |
| `GET /editorial/submissions?status=` · `GET /editorial/submissions/:id` | editor (scoped) | Review queue |
| `POST /editorial/submissions/:id/{claim,request-info,return,reject,risk,publish}` | editor (high risk: senior to publish) | Editorial actions |
| `GET /publisher/me` · `POST /publisher/announcements` | publisher | Policy-checked direct publish or review |
| `POST /articles/:id/reports` · `GET /moderation/reports` · `POST /moderation/reports/:id/resolve` | reader / editor | Reader reports |

## Phase 4 — AI verification
| `GET /editorial/submissions/:id/verification` · `POST .../verification/retry` | editor | The AI analysis for the current version; retry |

## Phase 5 — assistant
| `POST /assistant/ask` `{question, articleSlug?, locationId?, language, simple}` | reader | Answer from published articles with citations. Status `answered`, `insufficient_information` (no model call when nothing matches) or `unavailable`. 20 questions/hour/user |

## Phase 6 — deadlines and alerts
| Method & path | Auth | Purpose |
|---|---|---|
| `GET /articles/deadlines?locationId=&limit=` | — | Upcoming deadlines (today or later, India date), soonest first |
| `GET /me/notifications?cursor=&limit=` · `GET /me/notifications/unread-count` · `POST /me/notifications/read {ids?}` | reader | Alerts |
| `deadline` on `POST /editorial/articles`, `POST .../revisions` (correction only when changing), `POST .../submissions/:id/publish` | editor | Set or correct a deadline |

## Phase 7 — accountability and operations
| Method & path | Auth | Purpose |
|---|---|---|
| `GET /submissions/track-record` | reporter | Your own track record and the rules |
| `POST /submissions/:id/appeal {note}` | reporter (owner) | Appeal a rejection once, within 14 days |
| `GET /editorial/appeals?status=` · `POST /editorial/appeals/:id/decide {outcome, note}` | senior editor (not the one who rejected) | Decide appeals |
| `GET /admin/ops` · `POST /admin/jobs/:id/retry` | admin | Operations dashboard, retry failed jobs |
| `GET /admin/audit?action=&actorId=&targetId=&cursor=` | admin | Audit log (an `action` ending in `.` is a prefix) |

## Short-news posts
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /posts` (multipart: headline, summary ≤400, body?, language, locationId, categoryId, photo?) | reporter | Post; live at once (or held when risky) |
| `GET /posts/mine` · `DELETE /posts/:id` | reporter (owner) | Status and report counts; delete own |
| `GET /media/:id` | — | A post's photo (only while public; author and editors always) |
| `POST /articles/:id/reports` → `{message, removed}` | reader | The `REPORTS_TO_REMOVE`th report removes a reporter post |
| `GET /moderation/posts?reason=` · `POST /moderation/posts/:id/decide {decision, note}` | editor | Held / removed posts: restore or keep removed |
| `GET /config` | — | `{reporterSelfSignup, removeAfterReports}` for the UI |

## Two-step sign-in
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/login` | — | Returns `{user}`, or `{mfaRequired: true}` plus a 5-minute challenge cookie |
| `POST /auth/mfa {code}` | challenge cookie | 6-digit code or recovery code → session |
| `GET /me/mfa` · `POST /me/mfa/setup {currentPassword}` · `POST /me/mfa/enable {code}` | signed in | Status; start setup (secret + `otpauth://` link); confirm and get recovery codes |
| `POST /me/mfa/recovery-codes {code}` · `POST /me/mfa/disable {currentPassword, code}` | signed in | New recovery codes; turn off (not for staff when enforced) |
| `POST /admin/users/:id/mfa/reset` | admin (not self) | Lost phone: reset and sign out everywhere |

Rate limit added in Phase 8: `RATE_LIMIT_GLOBAL_PER_MIN` (default 300 per IP per minute) is configurable.
