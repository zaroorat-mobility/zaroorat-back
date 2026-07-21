# Coding Standards

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Enforced by:** ESLint + Prettier + Husky + TypeScript strict + CI + code review.

Rules are enforced, not aspirational. If a rule can be a linter rule, it is one.

---

## 1. Language & typing
- **TypeScript strict mode.** No implicit `any`; `strictNullChecks` on.
- **No `any`** without a `// reason:` comment justifying it. Prefer `unknown` + narrowing.
- Model domain values as **types/enums**, not loose strings (e.g. `TripStatus`, not `string`).
- Prefer `readonly` and immutability; avoid mutating function arguments.
- No non-null assertions (`!`) on values that can genuinely be null — handle the null.

## 2. Module structure (the layering contract)
Every `src/modules/<name>` follows the same shape:

```
index.ts          # public surface ONLY — what other modules may import
<name>.routes.ts       # HTTP routes + JSON Schemas
<name>.controller.ts   # HTTP ↔ service adapter; NO business logic
<name>.service.ts      # business rules & invariants (the real work)
<name>.repository.ts    # Prisma data access (only DB touchpoint for this domain)
<name>.events.ts       # domain events emitted / consumed
<name>.types.ts        # module-local types & DTOs
```

**Strict layering:** `routes → controller → service → repository → Prisma`. A layer calls only the layer directly below it.
- Business rules live in **services**. Controllers/routes hold none.
- DB access lives in **repositories**. Services never call Prisma directly.

## 3. Module boundaries
1. Import another module **only through its `index.ts`** — never deep-import its internals.
2. **One writer per table.** A module never writes another module's tables; it calls that module's service or emits a domain event ([Events](../01_ARCHITECTURE/EVENT_CATALOG.md)).
3. Shared, domain-free helpers go in `core`/`shared` — never copy-pasted between modules. `shared` holds **no** domain rules.

## 4. Naming
- Files: `kebab-case.ts`. Classes/types: `PascalCase`. Functions/vars: `camelCase`. Constants: `UPPER_SNAKE`.
- Booleans read as predicates: `isOperable`, `hasActiveTrip`.
- Domain events: past tense, dotted — `trip.completed`. Never imperative.
- Match the surrounding code's idiom; don't introduce a new style in an existing file.

## 5. Functions & errors
- Small, single-purpose functions. Guard clauses over deep nesting.
- **Throw typed domain errors** (from `core/`), let `middleware/error.ts` map them to HTTP. Never build ad-hoc `{ statusCode }` in a service.
- Never swallow errors silently. No empty `catch`.
- No secrets, tokens, or PII in error messages or logs.

## 6. Async & correctness
- Always `await` promises or explicitly return them; no floating promises (lint-enforced).
- Money and trip-state writes run **inside a transaction** and are **idempotent**.
- Assume **at-least-once**: request retries, duplicate socket messages, and re-run jobs must be safe.
- State transitions go through the owning state machine ([ER §4](../01_ARCHITECTURE/ER_DIAGRAM.md)); no ad-hoc `status` flips.

## 7. Comments
- Comment the **why**, not the **what**. Code says what.
- Match the file's existing comment density. Don't narrate obvious lines.
- `// TODO:` and `// FIXME:` must reference a ticket.

## 8. Imports & dependencies
- No vendor SDK imported inside a `module` — vendors live behind `config/*` + `integrations/` (ADR-0007).
- No `console.log` — use the structured logger ([Logging](./LOGGING_GUIDE.md)).
- Adding a dependency requires review: license, size, and maintenance are considered.

## 9. Formatting
- Prettier is the single source of truth for formatting; never hand-format against it.
- Husky pre-commit runs lint + format; CI re-checks. A red pipeline does not merge.

See [API Standards](../01_ARCHITECTURE/API_STANDARDS.md), [Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md), [Testing](./TESTING_GUIDE.md).
