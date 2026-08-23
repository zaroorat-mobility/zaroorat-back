# Zaroorat Mobility Backend Constitution

> **STATUS: RATIFIED**
>
> Every rule below was derived from conventions the committed codebase already enforces, and each cites the code, config or workflow that enforces it. Nothing here is aspirational and nothing is a placeholder.
>
> Rules are marked **[REQUIRED]** (non-negotiable; a violation is a defect), **[SHOULD]** (the established default; deviation needs a stated reason in review), or **[EXCEPTION]** (a project-specific carve-out that exists for a documented reason).

## 1. Modular Architecture and Module Boundaries

**1.1 [REQUIRED]** Feature code lives under `src/modules/<domain>/`, with the internal shape `controllers/ · routes/ · services/ · repositories/ · schemas/ · errors/ · events/ · metrics/ · types/ · jobs/ · consumers/` as applicable. Cross-cutting infrastructure lives in `src/core/`, shared utilities in `src/shared/`, configuration in `src/config/`.

**1.2 [REQUIRED]** Every module exposes a `register<Domain>Module(container)` function and is registered in `src/core/di.ts`. Routes are mounted in one place, `src/routes/register.ts`, under an `/api/v1/<domain>` prefix.

**1.3 [REQUIRED]** Dependency injection is Awilix with `InjectionMode.CLASSIC`. **Resolution is by constructor parameter name**, so renaming a constructor parameter is a breaking change. Aliases (`aliasTo`) are used where a service expects a shorter name than the registration key — e.g. `intentRepo` → `intentRepository` in `src/modules/payments/index.ts`.

**1.4 [REQUIRED]** A module owns the _mutation_ of its domain regardless of which schema file declares the table. `SettlementWalletRepository` (payments) owns writes to `driver_wallets`, which is why the drivers module's wallet repository exposes reads only — the boundary is documented in that file's own header comment. Financial mutation belongs to `payments`; ride lifecycle to `rides`; identity and role grants to `auth`.

**1.5 [SHOULD]** A module should not import another module's services directly where the transactional outbox already carries the fact. Reaction across modules goes through consumers (§7).

## 2. TypeScript and Backend Code Conventions

**2.1 [REQUIRED]** `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.json`). Optional properties are spread conditionally rather than assigned `undefined` — the `...(x !== undefined ? { x } : {})` idiom used throughout the repositories exists because of `exactOptionalPropertyTypes`.

**2.2 [REQUIRED]** Target ES2023, `module: NodeNext`. Path aliases `@core/* · @modules/* · @shared/* · @config · @config/*` are declared in `tsconfig.json` and rewritten at build time by `tsc-alias`. Relative deep imports across module boundaries are not the convention.

**2.3 [REQUIRED]** Lint gates from `eslint.config.js`: `no-console` (only `warn`/`error` permitted), `eqeqeq` (null-ignoring), `no-var`, `prefer-const`, and `@typescript-eslint/no-unused-vars` as an **error** with a `^_` prefix escape hatch. `eslint . --max-warnings=0` — zero warnings tolerated.

**2.4 [EXCEPTION]** `src/generated/` (Prisma client), `frontend/`, `dist/`, `coverage/` are lint-ignored. `scripts/**/*.js` and `prisma/seed/**/*.ts` may use `require()` and `console` — they are CommonJS terminal tools where that is correct, not a lapse. Root `*.config.js` may use `require()`.

**2.5 [SHOULD]** Comments explain _why_, particularly the non-obvious constraint a piece of code defends against. The codebase's prevailing style is a short `///` block above a method describing the failure it prevents.

## 3. Prisma and Database Migration Rules

**3.1 [REQUIRED]** Schema is split under `prisma/schema/` (`modules/<domain>/*.prisma`, `shared/enums.prisma`). The client generates to `src/generated/prisma`. `postgis` and `pgcrypto` extensions are declared and required.

**3.2 [REQUIRED]** Migrations are **additive and forward-only**. No migration rewrites, deletes or mutates existing rows of a financial table.

**3.3 [REQUIRED]** Constraints Prisma cannot express — partial unique indexes, `CHECK` constraints — are written as raw SQL in a migration. Precedent: `20260810100000_ride_request_unique`, `20260821130000_ride_active_uniqueness`, `20260822160000_ride_dispatch_timeout_index`.

**3.4 [REQUIRED]** `CREATE INDEX CONCURRENTLY` cannot run inside Prisma's migration transaction. On a large table, the index is created manually with `CONCURRENTLY` **before** `migrate deploy`, and the migration carries `IF NOT EXISTS` so it becomes a no-op. The migration must document this — see `20260822160000_ride_dispatch_timeout_index/migration.sql`.

**3.5 [REQUIRED]** A constraint that could fail against existing rows is verified against the target database before deploy. Never assumed clean.

**3.6 [REQUIRED]** `prisma-check.yml` runs `prisma:format` and `prisma:validate`, then `git diff --exit-code prisma/schema/`. A schema change that was not formatted and committed fails CI.

## 4. Transaction Boundaries for Financial and Concurrency-Sensitive Operations

**4.1 [REQUIRED]** Every write that moves value or resolves a race runs inside `TransactionManager.execute`. State change, money movement, accounting entries and the domain event commit together or not at all.

**4.2 [REQUIRED]** A transaction must not span a network call to a third party (§8).

**4.3 [REQUIRED]** Money movement produces a balanced double-entry group through `LedgerService`, which rejects any group whose debits and credits differ and any entry whose amount is not strictly positive (`postTransactionGroup`, asserted in `tests/unit/payments/ledger-invariant.test.ts`).

## 5. Row Locking and Conditional Claim Patterns

**5.1 [REQUIRED]** A balance or state row that two callers may contend for is locked with `SELECT … FOR UPDATE` before it is read-modified-written. Established implementations: `WalletRepository.lockForUpdate`, `SettlementWalletRepository.lockForUpdate`, `SettlementRepository.lockForUpdate`, `RideDispatchRepository.lockForUpdate` / `lockActionableOffer`, `RideRepository.lockForUpdate`.

**5.2 [REQUIRED]** A state transition that must have exactly one winner is a **conditional claim** — an `updateMany` guarded by the expected prior state, whose returned `count` decides the outcome. Established implementations: `RideDispatchRepository.respondIfPending`, `RideRepository.updateStatusIf`. The caller turns a lost claim into the correct error rather than overwriting a decision already made.

**5.3 [REQUIRED]** A Redis lock (`LockStore.acquire`/`release`, token-based) is an **optimisation that avoids wasted work, never the correctness boundary**. The database constraint or conditional claim is the guarantee. This was settled during the dispatch work and applies to every subsequent feature.

**5.4 [REQUIRED]** Uniqueness that must survive a lost lock or a hard crash is enforced by a database index, not by application logic.

## 6. Idempotency

**6.1 [REQUIRED]** Every mutating payment route requires an `Idempotency-Key` header and runs through `PaymentService.withIdempotency` → `IdempotencyRepository.runIdempotent`. Missing or blank key ⇒ `IdempotencyKeyRequiredError` before any effect.

**6.2 [REQUIRED]** Semantics, as implemented and tested (`tests/unit/payments/idempotency-required.test.ts`): same key + same payload replays the original response; same key + **different** payload raises `DuplicateIdempotencyKeyError`; keys are scoped `{userId}:{route}:{key}` so one user cannot replay another's result; a failed operation releases the key so a genuine retry can succeed; concurrent same-key requests produce exactly one effect via `runOnce`.

**6.3 [REQUIRED]** Storage is **Redis**, TTL from `paymentConfig.idempotencyTtlSeconds` (default 86400s). Payload identity is a SHA-256 of a sorted-key stable stringify, so key reordering is the same payload.

**6.4 [REQUIRED]** No second idempotency mechanism may be introduced. **[EXCEPTION]** Gateway webhooks legitimately use a different mechanism — unique `gatewayEventId` replay detection via `WebhookRepository.findOrPersist` — because the provider, not the client, supplies the identity.

**6.5 [EXCEPTION — known gap]** The `IdempotencyKey` Prisma model in `admin.prisma` is unused; Redis is the live mechanism. Do not "complete" the table believing it an oversight.

## 7. Transactional Outbox and Event Publishing

**7.1 [REQUIRED]** Domain events are published with `EventPublisher.publish(input, tx)`, writing to `outbox_events` **in the same transaction** as the state change. `OutboxRelay` drains committed rows onto the in-process `EventBus`.

**7.2 [REQUIRED]** Consumers are registered in exactly one place — the `CONSUMER_KEYS` list in `src/bootstrap/events.bootstrap.ts`. `registerEventConsumers()` is **pure**: it opens no sockets, starts no timers, touches no queue, so integration tests can subscribe and drive the relay by hand with `processBatch()`. Only `bootstrapEvents()` starts the relay.

**7.3 [REQUIRED]** Delivery is at-least-once. A consumer must be safe to run twice, and that safety must come from a database guarantee rather than from the relay.

**7.4 [REQUIRED]** `buildEnvelope` drops `aggregateId`, and `subject.userId` is null for ride events. Consumers read identifiers from `envelope.data`.

**7.5 [REQUIRED]** Never bypass the outbox to update a socket or a cache faster. A viewer must not see a fact the database does not record.

**7.6 [REQUIRED]** Two events must not describe the same state transition. If both would fire in one transaction, one of them is redundant.

## 8. External Provider I/O Outside Database Transactions

**8.1 [REQUIRED]** Payment-gateway calls, HTTP requests, push delivery and object-storage operations happen **outside** the transaction that records their outcome. Reference shape: `IntentService.confirmIntent` calls `gateway.confirmIntent(...)`, then opens a transaction to run `applyConfirmation`.

**8.2 [REQUIRED]** Holding a row lock across a third-party network call is prohibited.

**8.3 [REQUIRED]** Because a crash between the external call and the commit is possible, the external call carries a **deterministic idempotency key** so a recovery attempt returns the original effect instead of creating a second one.

## 9. Server-Authoritative Security and Financial Decisions

**9.1 [REQUIRED]** A client never supplies an amount the server treats as authoritative for a charge, and never declares an external payment successful. Provider confirmation, signature-verified, is the only authority.

**9.2 [REQUIRED]** Ownership is proven against the database, never from a client claim: `lockAndValidate` rejects a driver who is not `ride.driverId`; `assertOwnerOrStaff` guards per-user resources; `FileLifecycleService.assertReferenceable` proves file ownership and purpose.

**9.3 [REQUIRED]** Non-enumeration: a resource the caller may not see returns the same response as one that does not exist.

**9.4 [REQUIRED]** Webhook verification — signature, timestamp tolerance, missing-event-id rejection, replay detection — is a trust boundary and is not weakened. Covered by `tests/integration/payment-webhook.test.ts`.

## 10. Authentication and Authorization

**10.1 [REQUIRED]** Authorization is **deny-by-default**. `src/modules/auth/plugins/auth.plugin.ts` authenticates every route in its `onRequest` hook unless the route declares `config: { public: true }`.

**10.2 [REQUIRED]** Public routes are exceptional and must be justified. `tests/integration/payment-webhook.test.ts` asserts the gateway webhook is the **only** public payment route — a test that exists to stop a second one appearing quietly.

**10.3 [REQUIRED]** Route-level policy uses `fastify.authorize({ roles, requireOperableDriver, requireUntamperedDevice })`. `isOperableDriver` means verified **and** not suspended **and** not soft-deleted.

**10.4 [REQUIRED]** Caller identity comes from `callerId(req)` / `request.auth`, populated from verified JWT claims — never from a body or query field.

## 11. API and Schema Validation

**11.1 [REQUIRED]** Request bodies are validated with Zod schemas in the module's `schemas/` directory.

**11.2 [REQUIRED]** Every route path parameter that is a UUID carries a UUID pattern in its Fastify route schema, so a malformed id returns `400`, never `500`. Precedent: the `uuidParams` constant in `src/modules/rides/routes/ride.routes.ts`, added after a malformed UUID was empirically shown to produce a 500.

**11.3 [SHOULD]** A field a client must not control is removed from the schema rather than validated and ignored.

## 12. Configuration Validation

**12.1 [REQUIRED]** Numeric configuration is read through `numericEnv` (`src/config/env/numeric.ts`), which throws on non-numeric, non-finite and out-of-range values and names the variable and its default in the error.

**12.2 [REQUIRED]** Bare `Number(process.env.X)` in a path that guards behaviour is a defect. The reason is empirical, not stylistic: `Number('abc')` is `NaN`, every comparison against `NaN` is false, so an unvalidated knob **fails open**. Covered by `tests/unit/core/numeric-env.test.ts`.

**12.3 [REQUIRED]** Configuration that is invalid fails at boot, loudly, rather than degrading at runtime. Precedent: `PAYMENT_WEBHOOK_SECRET` is mandatory when a live gateway is configured (`payment.config.ts`).

**12.4 [REQUIRED]** Every knob is documented in `.env.example` with its default and bounds.

## 13. Error Handling and Coded Errors

**13.1 [REQUIRED]** Domain errors extend a module base error carrying `code` and `statusCode` — e.g. `RideError` in `src/modules/rides/errors/ride.errors.ts`, `PaymentError` in payments. Subclasses set a specific code and HTTP status (`INVALID_RIDE_STATE_TRANSITION` / 409, `ACTIVE_RIDE_EXISTS` / 409).

**13.2 [REQUIRED]** Responses use the shared envelope from `src/core/errors/envelope.ts`: `{ error: { code, messageKey, message, requestId, … } }`, with `messageKey` derived as `error.<lowercased code>` for client-side localisation.

**13.3 [REQUIRED]** Each module registers a `setErrorHandler` that surfaces coded errors **below 500** with their real code and status, and collapses anything else to a logged `INTERNAL` 500. Precedent: `handlePaymentError`, and the equivalents in drivers and rides.

**13.4 [REQUIRED]** `isCodedError` is the discriminator. Domain codes must reach the client rather than being flattened to a generic error — this was a real fix in the realtime gateway, where `IMPLAUSIBLE_LOCATION` was being masked by a generic `REALTIME_ERROR`.

## 14. Concurrency and Race-Condition Testing

**14.1 [REQUIRED]** Any code path where two callers can contend carries a test that actually runs them concurrently (`Promise.all`), not a test that reasons about the race. Established suites: `tests/integration/auth-concurrency.test.ts`, `auth-session-cap.test.ts`, the payout double-spend test in `earnings-pipeline.test.ts`, the concurrent same-key test in `idempotency-required.test.ts`.

**14.2 [REQUIRED]** The assertion is on the invariant — exactly one winner, balance never negative, charged at most once — not on which caller won.

**14.3 [REQUIRED]** Exactly-once behaviour is proven by replaying the triggering event or request, not only by a single happy-path call.

## 15. Unit and Integration Testing

**15.1 [REQUIRED]** Tests are `node:test` run through `tsx`. The full suite runs `--test-concurrency=1 --test-force-exit`; it takes roughly 11 minutes and is run in the background rather than against a foreground timeout.

**15.2 [REQUIRED]** Unit tests live in `tests/unit/<domain>/`, integration tests in `tests/integration/`. Integration tests boot the real Fastify app against a real PostgreSQL and Redis through `tests/integration/helpers/harness.ts`, and truncate named tables in `beforeEach`.

**15.3 [REQUIRED]** **A test is never weakened to make the suite pass.** A failure is diagnosed before it is characterised, and is never labelled pre-existing without reading its actual output. _(Precedent: `worker-health` was reported as a pre-existing failure and was in fact a Node-26-only teardown artifact that passes 5/5 on Node 22 — the label was wrong, and finding that changed the conclusion.)_

**15.4 [REQUIRED]** Money and security invariants are asserted **directly**, not as a side effect of another assertion.

**15.5 [SHOULD]** New behaviour ships with its test in the same change. Where a test-first order is practical, test tasks precede implementation tasks.

## 16. Backward-Compatible Deployment and Migration Practices

**16.1 [REQUIRED]** Node version is pinned in `.nvmrc` and consumed by every workflow via `node-version-file: .nvmrc`, and by the Dockerfile. Local, CI and production run the same major.

**16.2 [REQUIRED]** Deployment order is migrate-then-deploy: `production.yml` runs database migrations as a distinct step before rolling out the image. Migrations must therefore be compatible with the **previous** application version still running.

**16.3 [REQUIRED]** An API response change is additive where it can be. Removing or renaming a field a shipped client reads requires explicit release coordination.

**16.4 [REQUIRED]** `release.yml` verifies the git tag matches `package.json` version before publishing a release.

## 17. Observability and Audit for Money-Affecting Operations

**17.1 [REQUIRED]** Every money-affecting operation emits a domain metric through the module's metrics class — `PaymentMetrics` (`payment_success_total`, `payment_failure_total`, `webhook_duplicate_total`, `refund_total`, `payout_success_total`, `reconciliation_mismatch`…), built on `incrementCounter` from `@core/metrics`.

**17.2 [REQUIRED]** The ledger is the audit record. Money state is appended, never edited: a correction is a new balanced group, not an `UPDATE`.

**17.3 [REQUIRED]** Logging is `pino` with **mandatory redaction** (`src/shared/logger/redact.ts`) covering `password`, `token`, `accessToken`, `refreshToken`, `jwt`, `authorization`, `secret`, `phone`, `otp`, `body`, and related fields. A raw webhook payload or secret must never reach the logs — asserted by `payment-webhook.test.ts` ("does not log the raw payload or the secret").

**17.4 [REQUIRED]** Staff-initiated money movement records who performed it and why.

**17.5 [SHOULD]** A background job logs its outcome with a structured result object; `MAINTENANCE_HANDLERS` job completion and failure are already logged this way by the worker.

## 18. CI Quality Gates

**18.1 [REQUIRED]** `ci.yml` **quality** job: `format:check` → `lint` → `typecheck`. All three must pass.

**18.2 [REQUIRED]** `ci.yml` **tests** job runs against real service containers — `postgis/postgis:17-3.5` and `redis:8` with health checks — creating the `postgis` and `pgcrypto` extensions, applying `prisma migrate deploy`, and seeding roles before `npm test`. Tests are not run against mocks of the database.

**18.3 [REQUIRED]** `prisma-check.yml` fails on an unformatted or uncommitted schema change.

**18.4 [REQUIRED]** `security.yml` runs Gitleaks secret scanning and a production dependency audit.

**18.5 [REQUIRED]** Local hooks mirror CI at proportionate cost: `pre-commit` runs `lint-staged` on staged files only; `pre-push` runs the whole-project `typecheck` and `lint`. Hooks are not bypassed with `--no-verify` except where a documented environment fault makes them unrunnable, and the bypass is disclosed.

**18.6 [REQUIRED]** Commit messages are conventional-commit format with a **closed scope list** enforced by `commitlint.config.js`: `auth, driver, ride, payment, notification, admin, core, shared, config, db, api, logger, ci, deps, docker, infra, tooling, structure, release, docs`. **[EXCEPTION]** There is deliberately no `realtime` or `vehicle` scope; realtime work commits under `ride`.

## Additional Constraints

- **Deployment is single-instance for the realtime layer.** The Socket.IO adapter is in-memory by design and the Redis adapter fails closed at boot. No feature may assume horizontal scaling of the API until that is addressed.
- **Single currency (INR)** across the payment and pricing surface.
- **Package manager is npm**, enforced by an `only-allow` preinstall hook.

## Governance

This constitution supersedes ad-hoc convention where the two conflict. It records what the codebase already does; where a rule and the code disagree, one of them is a defect and the discrepancy must be resolved explicitly rather than ignored.

**Amendments** require a documented rationale and, where they change an enforced pattern, a migration plan for the code already following the old one.

**Complexity must be justified.** A new abstraction, dependency or mechanism carries the burden of showing an existing one does not suffice — §1.3, §6.4 and §7.1 exist because a second mechanism for a solved problem is the most common way this codebase degrades.

**A specification must not silently choose a business policy** on the product owner's behalf. Where a decision carries financial or user-visible consequence, it is escalated as a recorded decision, not defaulted.

**Version**: 1.0.0 | **Ratified**: 2026-08-23 | **Last Amended**: 2026-08-23
