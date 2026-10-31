# Phase 2 — Locations, articles and the news feed

Status: **In progress** · Last updated: 2026-10-10

## Goal
Readers can browse and follow places and categories and read published local news in Telugu or English, with each
article's source, trust label and correction history visible. Editors can publish, update, correct, unpublish and
retract articles. Admins maintain the location hierarchy.

## Decisions for this phase

| Decision | Why | Trade-off |
|---|---|---|
| **Locations are added by admins** (with an optional official LGD code), and a bulk LGD importer follows when the data file is available | Unblocks the feed without inventing data: every location is entered by a person who knows it exists | Slower to cover a whole district by hand; the importer fixes that later |
| **Editors publish directly in Phase 2** | Lets the team publish real news now; citizen submissions and the review queue are Phase 3 | No reporter workflow yet |
| **Editors are not yet limited to their districts** | The pilot is a single district | Location-scoped editors arrive with the Phase 3 editorial queue |
| **Categories are fixed product configuration**, created at startup | The master spec lists them; they change rarely | Adding one is a code change |
| **No multi-document transaction for publishing**: the revision is written first with a pre-allocated article id, then the article | Runs on the no-Docker standalone database (not a replica set); a failed second write leaves only an unreachable revision | A rare orphan revision, cleaned by a later job |
| **Retracted articles stay at their URL**, with the body withdrawn and the retraction notice shown | Accountability: deleting published news hides mistakes | — |
| **Text search uses a MongoDB text index with no language stemming** | MongoDB has no Telugu analyzer; whole-word matching works for Telugu and English | No partial-word or spelling-variant matching yet |

## Milestones
| Milestone | Delivers |
|---|---|
| **M2.1 Locations & categories** | `locations` with ancestors and effective dating fields; browse/search/detail API; admin create/edit; fixed categories (te/en) |
| **M2.2 Articles** | `articles` + immutable `article_revisions`; editor create, update/correct/clarify (with public note), unpublish/republish, retract (senior editor/admin); public article page data with correction history |
| **M2.3 Feed & search** | Public feed by location (inside it, plus district/state news above it) and category, keyset pagination; text search |
| **M2.4 Follows & saved** | Follow locations/categories, personalised feed, saved articles |
| **M2.5 Web** | Home feed with filters, article page, location pages, saved page, editor article pages, admin locations page — te/en, mobile-first |

## Acceptance criteria
- [x] AC1 Admins can build State → District → Mandal → Village; the level must match the parent; non-admins get 403.
- [x] AC2 Location search finds places by English or Telugu name.
- [x] AC3 Editors (and senior editors, admins) can publish; readers and reporters cannot (403).
- [x] AC4 Every change creates an immutable revision; corrections and clarifications require a public note and appear in the article's history.
- [x] AC5 Unpublished articles return 404 publicly and never appear in feeds or search; retracted articles show a notice and no body.
- [x] AC6 Feed for a district includes its mandals' and villages' news; feed for a village includes its district's and state's news.
- [x] AC7 Feeds paginate without duplicates or gaps while new articles are published.
- [x] AC8 Signed-in readers can follow locations/categories and see a personalised feed; they can save articles.
- [x] AC9 Search finds published articles by words in the headline or summary (Telugu and English).
- [x] AC10 All new UI strings exist in Telugu and English; pages fit 360 px.

**Result:** all ten verified by API tests (`geo`, `articles`, `engagement`, `phase2-extras`) and in the browser (Guntur district created, article published, followed, saved; 360 px layout). See `08-phases-3-8.md` for later phases.
