# LocalLens AI

Hyperlocal news and community information for Telugu-speaking communities in Andhra Pradesh: a short-news card feed
(one story per screen), reporters posting news with a photo in seconds, readers reporting wrong news (enough reports
remove it automatically), citizen journalism, editorial accountability, AI-assisted verification that advises editors but never publishes, a news
assistant that answers only from published articles, deadline tracking and in-app alerts.

**Status:** Phases 1–8 implemented for the Guntur pilot — results and what was verified:
[`docs/08-phases-3-8.md`](docs/08-phases-3-8.md). Running it: [`docs/09-operations.md`](docs/09-operations.md).

## Stack
React + Vite + TypeScript + Tailwind · Node.js + Express 5 + TypeScript · MongoDB (data and the background-job
queue) · Redis (rate limits) · Python + FastAPI AI service (Ollama locally, Claude in production) · Docker Compose. Reasoning and trade-offs: [`docs/02-architecture.md`](docs/02-architecture.md).

Sign-in is **email + password**. No email is ever sent: there is no verification step, and forgotten passwords are
reset by an admin (one-time temporary password).

## Prerequisites
- Node.js 22 (`.nvmrc`)
- Docker Desktop (for MongoDB and Redis) — or use the no-Docker standalone mode below

## Run it

### Option A — no Docker (quickest)
```bash
npm install
npm run dev:standalone        # API http://localhost:4100 + web http://localhost:5180
```
Runs a local MongoDB with data kept in `.data/standalone-db` (delete the folder to start fresh).

### Option B — full local stack
```bash
cp .env.example .env
docker compose up -d          # MongoDB :27018, Redis :6380
npm install
npm run dev
```

### AI checks and the assistant (optional)
Without this, everything works except AI analysis and the assistant (they show "unavailable").
```bash
cd services/ai
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # macOS/Linux: .venv/bin/python
cp .env.example .env                                          # set AI_SERVICE_TOKEN; same value in the root .env
.venv/Scripts/python -m uvicorn --factory app.main:create_app --host 127.0.0.1 --port 4200
```
Then set `AI_SERVICE_URL=http://127.0.0.1:4200` and `AI_SERVICE_TOKEN` in the root `.env` and restart the API.
Local model: install [Ollama](https://ollama.com) and run `ollama pull llama3.2` (free; slow on a CPU).

### Sign in
Open http://localhost:5180/register to create an account (name, email, password, and whether you also want to report
news — reporter access is a request an admin approves). Ready-made test accounts (reader, reporter, editor, admin):
`npm run seed:dev` — see [docs/dev-test-accounts.md](docs/dev-test-accounts.md).

### Make yourself an admin
```bash
npm run admin:promote -- you@example.com
```
(There is deliberately no HTTP endpoint for becoming an admin.)

### Production image
```bash
AI_SERVICE_TOKEN=<32+ random characters> docker compose --profile app up -d --build   # API + web on :4100, AI service
```

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + web dev server, using Docker MongoDB/Redis |
| `npm run dev:standalone` | Same, without Docker |
| `npm run seed:dev` | Create/reset local test accounts |
| `npm test` | API integration tests (in-memory MongoDB) + web component tests |
| `services/ai`: `python -m pytest -q` | AI service tests (no model or network needed) |
| `node scripts/load-test.mjs [url]` | Read-path load test (see `docs/09-operations.md`) |
| `npm run locations:import -- <file.csv>` | Import LGD villages/mandals (see `docs/data-sources/locations-lgd.md`) |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run lint` | ESLint |
| `npm run build` | Production build (web → `apps/web/dist`, API → `apps/api/dist`) |

The first `npm test` downloads a MongoDB test binary (~600 MB archive) once; later runs take seconds.

## Layout
```
apps/api            Express API — modules: identity, audit, geo, catalog, publishing, engagement, newsroom,
                    moderation, jobs, verification, assistant, notifications, admin
apps/web            React app (te/en)
packages/contracts  Zod schemas shared by API and web — the API contract in code
services/ai         Python FastAPI AI service (verification pipeline, news assistant)
scripts/            Load test
docs/               Requirements, architecture, data model, API contracts, security model, phase results, operations
```

## Documentation
1. [Product requirements](docs/01-product-requirements.md) — scope, publication policy, pilot assumptions
2. [Architecture](docs/02-architecture.md) — decisions, trade-offs, article lifecycle, cost
3. [Data model](docs/03-data-model.md)
4. [API contracts](docs/04-api-contracts.md)
5. [Security model](docs/05-security-model.md)
6. [Phase 1 plan & acceptance criteria](docs/06-phase-1-plan.md) · [Phase 2](docs/07-phase-2-plan.md)
7. [Phases 3–8: decisions and results](docs/08-phases-3-8.md)
8. [Operations and runbooks](docs/09-operations.md) — health, backups and restore, incidents, load test, deploys
9. [Location data source (LGD)](docs/data-sources/locations-lgd.md)
10. [Development test accounts](docs/dev-test-accounts.md)
