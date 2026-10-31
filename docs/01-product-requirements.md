# LocalLens AI — Product Requirements

Status: **Finalized for the initial release (Phases 1–3)** · Last updated: 2026-10-10

> **Source of requirements.** This document is derived from the LocalLens AI master specification.
> The copy available while writing it was **truncated partway through Feature D (AI News Assistant)**.
> Requirements that would come from the missing sections are **not invented here**; they are listed in §9 as gaps.

---

## 1. Product vision

A hyperlocal news and community-information platform for Telugu-speaking communities in Andhra Pradesh (English supported,
more Indian languages later) that combines hyperlocal news, citizen journalism, AI-assisted verification, evidence-backed
reporting, official announcement tracking, personalised feeds and editorial accountability.

**Core rule:** reading, submitting, editorial review and publishing must work with every AI service switched off.

## 2. Guiding principles

1. **Humans publish; AI advises.** No AI component can change an article's public status.
2. **Works without AI.** AI output is an attachment to a submission, never a gate in front of it.
3. **Unverified ≠ false.** "No evidence found" is *insufficient evidence*, never *contradicted*.
4. **Identity ≠ truth.** A verified publisher or high-reputation reporter is still not proof that a claim is true.
5. **Everything is auditable.** Every status change records who, what, when and why.
6. **Mobile-first, low-bandwidth-first.**

## 3. Users and roles

| Role | Granted by | Key permissions |
|---|---|---|
| `reader` | Automatically, when the account is created | Read, follow, save, report content |
| `reporter` | Admin, approving a request the user makes at sign-up or later | Draft and submit stories, see **own** submissions only |
| `editor` | Admin, **scoped to locations** | Review/approve/reject/publish within scope, issue corrections |
| `senior_editor` | Admin | Editor + required sign-off for high-risk stories, retractions |
| `publisher` | Admin, after organisation onboarding | Direct-publish **allow-listed announcement categories** within an authorised jurisdiction |
| `admin` | Bootstrap CLI / another admin | Users, roles, categories, locations, moderation, audit |

Users can hold several roles. Anonymous visitors can read published content only.

**Decision — users choose what they want to do, admins grant what they may do.** At sign-up a user picks "read news" or
"also report news". Readers are active immediately; "report news" creates a *reporter request* that an admin approves or
declines. Editor, senior editor, publisher and admin can never be self-selected — otherwise anyone could publish.

## 4. Publication policy (hybrid)

| Content | Path to publication | Public label |
|---|---|---|
| Citizen-submitted news | Editorial review → editor publishes | "Citizen report — reviewed by an editor, not independently verified", or "Verified by LocalLens" if the editor verified key claims |
| Sensitive claims, allegations against people, crime, communal/caste content, health emergencies, disasters, minors | Editorial review → **senior editor** publishes | As above |
| Emergency information | Senior editor only, regardless of source | "Emergency update" + source |
| Official announcement in an **allow-listed low-risk category** (routine notices, deadlines, schedules) from an **onboarded, authorised publisher**, within its **jurisdiction** | Direct publish after permission checks | **"Official source — not independently verified"** + mandatory link to the original document |
| Official announcement outside the allow-list or jurisdiction | Editorial review | "Official source — …" |

Direct publication requires **all** of: active `publisher` role, organisation status `active`, category in the publisher's
allow-list, location inside the publisher's jurisdiction, and an original-source URL. Any failure routes the item to
editorial review instead of rejecting it. Editors can unpublish or correct publisher content like any other article.

## 5. Initial release scope (Phases 1–3)

**In scope**
- Email + password authentication (no verification email), reporter requests with admin approval, admin password resets, sessions, role-based authorization, rate limiting.
- Location hierarchy State → District → Mandal → Village, imported from the official LGD dataset (pilot: Guntur district).
- Categories: local events, education, employment, agriculture, civic issues, government announcements, public safety, community news.
- Published articles with immutable revisions, correction history and trust labels.
- Hyperlocal feed: browse by location and category, follow locations, keyset pagination, basic search, saved articles.
- Telugu and English UI; content tagged with its language.
- Basic editorial controls: reporter submissions (text + supporting URLs), editorial queue, request info, approve, reject with reason, publish, correct, retract; publisher direct publication per §4; audit log.
- Responsive, mobile-first web UI with loading, empty, error and offline-friendly states.

**Out of scope for the initial release** (designed for, built later)
- AI verification pipeline, AI news assistant (AI service exists only as a stub).
- Media uploads (needs the scanning/re-encoding pipeline — Phase 4+).
- Duplicate detection, reputation, alerts/push notifications, Google OAuth.
- Email delivery (verification, self-service password reset) and phone OTP — tried and removed in Phase 1 because no
  email/SMS provider is set up; can return once one is.

## 6. Functional requirements — initial release

### 6.1 Authentication & accounts (Phase 1)
- FR-A1 Users sign up with name, email, password (8–128 chars), preferred language (`te`/`en`), and choose "read news" or "also report news". The account works immediately; no email is sent.
- FR-A2 Users sign in with email and password; wrong email and wrong password give the same message.
- FR-A3 Users can change their password (current password required; other devices are signed out).
- FR-A4 Sign in creates a server-side session (httpOnly cookie); sign out revokes it; "sign out everywhere" revokes all.
- FR-A5 Users can ask for reporter access at sign-up or later from their account page; admins approve or decline with an optional note.
- FR-A6 Users can update display name and preferred language.
- FR-A7 Admins can list and search users (by email or name), filter pending reporter requests, change roles, reset passwords (one-time temporary password, must be changed), and suspend/reactivate accounts (suspension revokes sessions immediately).
- FR-A8 Brute-force protection: per-IP limits on sign-in and sign-up, and a 15-minute lock after 5 failed sign-ins on one account.
- FR-A9 Authentication and authorization events are written to an append-only audit log (never passwords).

### 6.2 Locations & catalog (Phase 2)
- FR-L1 Locations imported from LGD with official codes, English and local-language names, and parent links.
- FR-L2 New districts can be imported later with **no schema change**.
- FR-L3 Location search by English, Telugu and common romanised spellings.
- FR-L4 Locations are effective-dated; renamed or split units remain resolvable for old articles.

### 6.3 Articles & feed (Phase 2)
- FR-F1 Public endpoints return only published, corrected or retracted-with-notice articles.
- FR-F2 Feed by location (including everything inside it) and category, newest first, keyset-paginated.
- FR-F3 Following a village also shows district- and state-level news for that village.
- FR-F4 Article page shows publication date, last-updated date, source type, trust label, original-source link (if any) and full correction history.
- FR-F5 Signed-in readers can follow locations and categories and save articles.
- FR-F6 Basic search over headline and summary in Telugu and English.

### 6.4 Editorial controls (Phase 3)
- FR-E1 Reporters create drafts and submit stories with headline, body, category, location, incident date, supporting URLs and editor-only context.
- FR-E2 Reporters see a timeline of their submission's status and editor messages; they can answer info requests.
- FR-E3 Editors see a queue limited to their location scope, ordered by risk and age.
- FR-E4 Editors can request info, return for revision, reject (reason code + note), approve and publish; high-risk items need a senior editor.
- FR-E5 Corrections, updates, clarifications and retractions create a new immutable revision and a public notice.
- FR-E6 Readers can report an article; reports enter a moderation queue.
- FR-E7 Publisher direct publication per §4.

## 7. Non-functional requirements

| Area | Target |
|---|---|
| Performance | Feed API p95 < 300 ms; first contentful paint < 2.5 s on a mid-range Android phone over 4G |
| Page weight | Initial JS < 200 KB gzipped |
| Availability | Read path keeps working if Redis or AI services are down |
| Security | OWASP ASVS L2 as the checklist (see `05-security-model.md`) |
| Privacy | Data minimisation; deletion on request; align with India's DPDP Act 2023 (**legal review required**) |
| Regulatory | Grievance-redressal process for a digital news publisher under the IT Rules 2021 (**legal review required**) |
| Accessibility | WCAG 2.1 AA; Noto Sans Telugu; no fixed-height text containers |
| Cost | Pilot runs on free tiers or one small VM (see `02-architecture.md` §8) |

## 8. Pilot: Guntur district — assumptions to validate before committing

The pilot is **provisional**. Each assumption below should be checked with local readers, contributors and editors before
we invest in Phase 3 features that depend on it.

| # | Assumption | Why it matters | How to validate |
|---|---|---|---|
| P1 | Readers want news at **village** level, not just mandal or town level | Drives the feed and follow UX | 10–15 interviews across urban Guntur and rural mandals; card-sort of follow choices |
| P2 | Readers are comfortable signing up with **email + password** | Many rural users rarely use email; forgotten passwords need an admin | Measure sign-up drop-off and admin reset requests in the pilot; revisit phone OTP if high |
| P3 | Telugu-first UI is expected; English is secondary | Default language, font and typography choices | Language preference split among pilot users |
| P4 | Users type Telugu, English, *and* romanised Telugu in search | Search and location alias design | Log anonymised search queries in the pilot |
| P5 | Enough willing **citizen contributors** and at least 2 **editors** exist | Without them there is no supply of local news | Recruit before Phase 3 ends; target ≥ 15 active contributors |
| P6 | District and mandal **notices are published online** in a linkable form | Publisher path and future verification depend on it | Survey the district website and department portals for 4 weeks |
| P7 | Guntur's **post-2022 boundaries** in LGD match what residents call "Guntur" | Areas moved to the new Bapatla and Palnadu districts may still be called "Guntur" locally | Compare LGD data with contributor knowledge; add aliases |
| P8 | Most access is via **mobile browsers on mid-range Android** with intermittent data | Performance budget, offline caching | Analytics on device class and connection type |
| P9 | **WhatsApp sharing** is the main way stories spread | Link previews (Open Graph tags) must work | Track share referrers |
| P10 | Telugu UI strings written by the team are clear to local readers | Wording quality | Native-speaker review before pilot launch |

## 9. Gaps — requirements not available

The master specification was cut off after the first requirements of **Feature D (AI News Assistant)**. Not available:
the rest of Feature D, and any later features or sections (likely announcement/deadline tracking, alerts, observability,
deployment and testing requirements). Nothing in this document fills those gaps. **They are needed before Phase 4 planning.**
