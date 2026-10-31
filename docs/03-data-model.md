# LocalLens AI — Data Model (MongoDB)

Status: **Phase 1 collections implemented; Phase 2–3 collections finalized as design** · Last updated: 2026-10-10

Conventions: `_id` is an ObjectId unless stated; timestamps are UTC `Date`; enum values are lowercase snake_case;
every collection has `createdAt`/`updatedAt` unless it is append-only.

---

## Phase 1 — identity & audit (implemented)

### `users`
| Field | Type | Notes |
|---|---|---|
| `email` | string | Lowercased, trimmed. **Unique index**. Not verified — it is a login name |
| `passwordHash` | string | Argon2id PHC string (m=19 MiB, t=2, p=1; includes salt) |
| `mustChangePassword` | boolean | Set by an admin reset; cleared when the user picks a new password |
| `displayName` | string | 2–60 chars |
| `preferredLanguage` | `"te" \| "en"` | Default `te` |
| `roles` | string[] | Subset of `reader, reporter, editor, senior_editor, publisher, admin` |
| `status` | `"active" \| "suspended"` | |
| `reporterRequest` | `{ status: "none"\|"pending"\|"approved"\|"rejected", requestedAt, decidedAt, decidedBy, note }` | Asking ≠ granting: approval adds the `reporter` role |
| `editorScopes` | ObjectId[] | Location IDs (Phase 2). Additive field — no migration needed |
| `publisherOrgId` | ObjectId \| null | Phase 3 |

Indexes: `{ email: 1 }` unique; `{ roles: 1 }`; `{ "reporterRequest.status": 1, "reporterRequest.requestedAt": 1 }`.

### `sessions`
| Field | Type | Notes |
|---|---|---|
| `tokenHash` | string | SHA-256 of the cookie value. **Unique index**. The raw token is never stored |
| `userId` | ObjectId | Index |
| `expiresAt` | Date | Absolute expiry (30 days). **TTL index** (`expireAfterSeconds: 0`) |
| `idleExpiresAt` | Date | Sliding expiry (7 days), refreshed at most every 5 minutes |
| `ip`, `userAgent` | string | For "your sessions" UI and incident response |

Why two different hashes: session tokens have 256 bits of entropy, so a fast SHA-256 is enough. Passwords are
low-entropy and human-chosen, so they need a deliberately slow, memory-hard hash (Argon2id).

### `audit_events` (append-only)
| Field | Type | Notes |
|---|---|---|
| `at` | Date | Index `{ at: -1 }` |
| `actorId` | ObjectId \| null | null for anonymous actions (failed logins) |
| `action` | string | e.g. `auth.login_succeeded`, `auth.login_failed`, `admin.password_reset`, `admin.reporter_approved` |
| `targetType`, `targetId` | string | e.g. `user`, `<id>` |
| `requestId`, `ip` | string | |
| `metadata` | object | Never contains passwords or tokens |

Index `{ targetType: 1, targetId: 1, at: -1 }`. Retention: 1 year (to be confirmed in legal review).

---

## Phase 2 — geography, catalog, articles, engagement (design)

### `locations`
| Field | Type | Notes |
|---|---|---|
| `level` | `"state" \| "district" \| "mandal" \| "village"` | Extensible (e.g. `ward`, `town`) without schema change |
| `lgdCode` | string | Official LGD code. **Unique with `level`** |
| `parentId` | ObjectId \| null | |
| `ancestorIds` | ObjectId[] | Ordered root → parent. **Multikey index** |
| `name` | `{ en: string, te?: string }` | `te` from LGD local-language name field |
| `aliases` | string[] | Normalised alternative spellings (romanised, old names) |
| `searchKeys` | string[] | Lowercased, diacritic-folded name + aliases; indexed |
| `validFrom`, `validTo` | Date \| null | Effective dating; `validTo` set when a unit is split/renamed |
| `successorIds` | ObjectId[] | Where a retired unit's area went |
| `source` | `{ dataset, version, importedAt }` | Provenance of every row |

Why `ancestorIds` rather than a path string: "everything in Guntur district" is `{ ancestorIds: gunturId }`, a single
multikey index lookup; "the ancestors of this village" is already on the document. Adding a district = importing
documents, never changing the schema.

### `categories`
`{ slug (unique), name: { en, te }, sortOrder, active, publisherDirectPublish: boolean }`
`publisherDirectPublish` marks categories eligible for the publisher fast path (e.g. `routine_notice`, `deadline`).

### `articles` (public objects only)
| Field | Type | Notes |
|---|---|---|
| `slug` | string | Unique |
| `status` | `"published" \| "unpublished" \| "retracted"` | Only `published` and `retracted` are publicly visible |
| `currentRevisionId` | ObjectId | |
| `headline`, `summary`, `body` | string | Denormalised copy of the current revision for fast reads |
| `language` | `"te" \| "en"` | |
| `locationId` | ObjectId | |
| `locationLineage` | ObjectId[] | `[locationId, ...ancestorIds]`, multikey indexed — powers feeds |
| `categoryId` | ObjectId | |
| `sourceType` | `"citizen" \| "staff" \| "official_publisher"` | |
| `trustLabel` | `"official_unverified" \| "editor_verified" \| "citizen_reviewed" \| "developing"` | |
| `originalSourceUrl` | string \| null | Required when `sourceType = official_publisher` |
| `firstPublishedAt`, `lastUpdatedAt` | Date | |
| `correctionCount` | number | |
| `submissionId` | ObjectId \| null | Link back to the newsroom (never exposed publicly) |
| `searchText` | string | Normalised text for the text index |

Indexes: `{ status: 1, firstPublishedAt: -1, _id: -1 }`; `{ status: 1, locationLineage: 1, firstPublishedAt: -1, _id: -1 }`;
`{ status: 1, categoryId: 1, firstPublishedAt: -1, _id: -1 }`; text index on `searchText` with `default_language: "none"`.

**Feed query for a reader following village V** (V's ancestors are D, S):
`status ∈ {published}` AND (`locationLineage ∋ V` OR `locationId ∈ {D, S}`), sorted `firstPublishedAt desc, _id desc`,
keyset cursor `(firstPublishedAt, _id)`. Keyset pagination stays fast at any depth and does not skip or duplicate items
when new articles are published while the reader scrolls (offset pagination does both).

### `article_revisions` (immutable)
`{ articleId, revisionNumber, headline, summary, body, editorId, changeKind: "initial"|"update"|"correction"|"clarification"|"retraction", publicNote, createdAt }`
Unique `{ articleId, revisionNumber }`.

### `follows`, `saved_articles`
`follows { userId, targetType: "location"|"category", targetId }` unique on all three.
`saved_articles { userId, articleId, savedAt }` unique `{ userId, articleId }`.

---

## Phase 3 — newsroom (implemented)

### `submissions`
`{ reporterId, origin: "citizen"|"publisher", status, version, headline, summary, body, language, locationId,
locationLineage, districtId, categoryId, incidentDate, supportingUrls, editorContext, originalSourceUrl, deadline,
riskLevel, riskRank, riskReasons, riskSetByEditor, aiStatus, possibleDuplicateIds, assignedEditorId, articleId,
publishLockAt, submittedAt, queueAt }`
- `queueAt` (Phase 7) = `submittedAt` minus the reporter's track-record head start; the review queue sorts by
  `riskRank desc, queueAt asc, _id`. Backfilled from `submittedAt` at startup for older documents.
Indexes: `{ reporterId: 1, updatedAt: -1 }`; `{ status: 1, riskRank: -1, queueAt: 1, _id: 1 }`; `{ districtId: 1, submittedAt: -1 }`; `{ locationLineage: 1, status: 1 }`.

### `submission_versions` (immutable)
Snapshot of reporter-editable fields each time the reporter submits, so editors can see what changed.

### `editorial_events` (append-only)
`{ submissionId, actorId, actorRole: "reporter"|"editor"|"system", action, fromStatus, toStatus, reasonCode, note, visibleToReporter, at }`

### `publisher_orgs`
`{ name: {en, te}, status, jurisdictionLocationIds, allowedCategoryIds, officialDomains, verifiedBy, verifiedAt }`

### `content_reports`
`{ articleId, reporterUserId, reason, details, status: "open"|"actioned"|"dismissed", handledBy, at }` — unique per (user, article).

## Phase 4 — jobs and AI verification

### `jobs`
`{ type, payload, dedupeKey (unique when set), status: "pending"|"running"|"succeeded"|"failed"|"dead", attempts, maxAttempts, runAfter, lockedUntil, lockedBy, lastError }`
(Replaces the planned `outbox`; see architecture D7.)

### `verification_reports`
`{ submissionId, submissionVersion (unique together), status: "pending"|"completed"|"failed"|"unavailable", error, attempts, result (the AI service's validated response), requestedAt, finishedAt }`

## Phase 5 — assistant

### `assistant_cache`
`{ key (sha256 of question + language + simple + article ids/revisions), response, expiresAt (TTL) }` — 24 h.
**Questions are not stored in plain text**; only this hash.

## Phase 6 — deadlines and alerts
- `articles.deadline` and `article_revisions.deadline` (a date, stored as UTC midnight of the India date). Changing a
  published deadline must be a correction with a public note.

### `notifications`
`{ userId, kind: "new_article"|"article_corrected"|"article_retracted"|"deadline_soon", articleId, revision, readAt, createdAt }`
Unique `{ userId, kind, articleId, revision }` (nobody is notified twice); `revision` is the article revision, or the
deadline as `yyyymmdd` for reminders (a changed deadline re-arms the reminder). TTL: deleted after 90 days.
Also added: `follows { targetType, targetId }` and `saved_articles { articleId }` indexes for fan-out.

## Phase 7 — accountability

### `appeals`
`{ submissionId (unique), reporterId, rejectedBy, note, status: "open"|"upheld"|"overturned", decidedBy, decisionNote, decidedAt, createdAt }`

`users.mfa` (two-step sign-in): `{ enabled, secretEnc (AES-256-GCM), pendingSecretEnc, lastUsedStep, recoveryCodeHashes, enabledAt }`.
`mfa_challenges`: `{ tokenHash, userId, attempts, expiresAt (TTL, 5 minutes) }`.

Track records are **computed, not stored**: counts of the reporter's decided submissions (last 180 days), their
articles' corrections/retractions, and overturned appeals. Nothing to go stale, nothing hidden.

`audit_events` gained an `{ action: 1, at: -1 }` index for the admin audit viewer.
