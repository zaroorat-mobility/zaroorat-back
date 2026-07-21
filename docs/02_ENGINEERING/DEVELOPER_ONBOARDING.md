# Developer Onboarding

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> Welcome to Zaroorat. This gets you from zero to a merged PR.

---

## 1. Read first (in order, ~1 hour)
1. [Project Vision](../00_PROJECT/PROJECT_VISION.md) — what and why.
2. [System Architecture](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md) — the shape of the system.
3. [ER Diagram](../01_ARCHITECTURE/ER_DIAGRAM.md) + [Sequence Diagrams](../01_ARCHITECTURE/SEQUENCE_DIAGRAMS.md) — data and the core loop.
4. [Coding Standards](./CODING_STANDARDS.md), [Git Workflow](./GIT_WORKFLOW.md), [API Standards](../01_ARCHITECTURE/API_STANDARDS.md).
5. Skim the [ADRs](../01_ARCHITECTURE/ADR/) — the decisions and why.

## 2. Mental model (the 8 golden rules)
1. Postgres is truth; Redis is speed.
2. `rides` owns trip state; everyone else asks.
3. Workers own time.
4. Money is transactional and idempotent — always.
5. One writer per table; cross domains via services/events.
6. Validate at the edge; deny by default.
7. Everything important leaves an append-only audit trail.
8. Vendors are swappable — no SDK imports inside modules.

## 3. Local setup
```bash
# prerequisites: Node.js, Docker
git clone <repo> && cd backend_zaroorat
cp .env.example .env            # fill in local/sandbox values
docker-compose up -d            # Postgres + Redis (+ services)
npm install
npx prisma migrate dev          # apply migrations
npx prisma db seed              # deterministic seed data
npm run dev                     # API (Fastify + Socket.io)
npm run dev:worker              # workers (BullMQ)   [separate terminal]
```
- Swagger/OpenAPI is served by the running API — that's the live API contract.
- If boot fails immediately, it's almost always an invalid `.env` (config fails fast — [Environment](./ENVIRONMENT_GUIDE.md)).

## 4. Repo layout (where things live)
```
src/app        boot / server / shutdown
src/config     validated env + provider adapters
src/plugins    Fastify plugins (jwt, prisma, redis, socket, ...)
src/middleware auth, role, error, request-id, idempotency
src/modules    the domain — 23 bounded contexts
src/workers    BullMQ jobs
src/core       framework-agnostic building blocks
prisma         schema (source of truth), migrations, seed
tests          unit + integration
docs           you are here
```
A module's internal shape and layering: see [Coding Standards §2](./CODING_STANDARDS.md).

## 5. Your first change (walkthrough)
1. Pick a small issue; branch `feat/…` or `fix/…` off `main`.
2. Work within **one module**; keep the `routes → controller → service → repository` layering.
3. Add tests for the behavior ([Testing](./TESTING_GUIDE.md)).
4. Run `npm run lint && npm test` locally.
5. Open a PR: what / why / how-to-test; update docs if behavior changed.
6. Address review comments; merge on green ([Code Review](./CODE_REVIEW.md)).

## 6. Common tasks
| Task | Where to look |
|---|---|
| Add an endpoint | module `*.routes.ts` + `*.controller.ts` + `*.service.ts` ([API Standards](../01_ARCHITECTURE/API_STANDARDS.md)) |
| Change the schema | `prisma/schema.prisma` + migration ([Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md)) |
| Add async work | `src/workers/*` ([Queues](../01_ARCHITECTURE/QUEUE_GUIDE.md)) |
| Emit/consume an event | `*.events.ts` ([Events](../01_ARCHITECTURE/EVENT_CATALOG.md)) |
| Add config | `config/env.schema.ts` ([Environment](./ENVIRONMENT_GUIDE.md)) |

## 7. Getting help
- Check the relevant doc first — it probably answers you.
- Still stuck? Ask; then improve the doc so the next person isn't stuck.
- If a doc and the code disagree, that's a bug — raise it.

## 8. Ops awareness (before you're on call)
Skim [Monitoring](../03_OPERATIONS/MONITORING.md), the [Runbook](../03_OPERATIONS/RUNBOOK.md), and [Incident Response](../03_OPERATIONS/INCIDENT_RESPONSE.md).
