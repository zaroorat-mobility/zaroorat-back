# Code Review

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [Git Workflow](./GIT_WORKFLOW.md), [Coding Standards](./CODING_STANDARDS.md)

Review protects correctness, shares knowledge, and keeps the codebase coherent. It is not a gate to argue past — it's how we stay fast without breaking money and trips.

---

## 1. Ground rules

- Every change merges via PR with **at least one approval** and green CI.
- Review the **diff and its context** — open the files, don't rubber-stamp.
- Be kind and specific. Critique the code, not the person. Explain the _why_.
- Small PRs get faster, better reviews. Push back on oversized PRs by asking to split.
- The author is responsible for the change; the reviewer is a second set of eyes, not a co-author.

## 2. What the reviewer checks

### Correctness (highest priority)

- [ ] Does it do what the PR says, and handle the failure paths (not just the happy path)?
- [ ] **Money & trip-state:** transactional? idempotent? goes through the state machine / owning service?
- [ ] **Boundaries:** imports other modules only via `index.ts`? one writer per table?
- [ ] **Concurrency:** safe under retries, duplicate messages, re-run jobs?
- [ ] **Authorization:** endpoint declares auth + role; returns only the caller's data?

### Data

- [ ] Migration reviewed (indexes, nullability, lock/backfill impact, constraints) — [Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md).
- [ ] Repositories are the only DB access; services don't call Prisma.

### Quality

- [ ] Tests cover the new business logic and the tricky failure cases ([Testing](./TESTING_GUIDE.md)).
- [ ] Errors are typed and centralized; no leaked internals; no `console.log`.
- [ ] Matches surrounding style; naming is clear; no dead code or stray TODOs without tickets.
- [ ] Structured logs with `requestId`; no secrets/PII logged.

### Docs

- [ ] Behavior/architecture change updates the relevant doc **in the same PR**.
- [ ] API change updates the route schema / Swagger.

## 3. Severity language (use it)

- **blocking:** must fix before merge (correctness, security, data risk).
- **should:** strong suggestion; fix or justify.
- **nit:** optional/style; author's discretion.

Prefix comments so the author knows what's required vs. optional.

## 4. Author responsibilities

- Self-review the diff before requesting review.
- Write a PR description: what, why, how to test; link the FR/issue.
- Keep it focused; respond to every comment (fix or explain).
- Don't merge with unresolved **blocking** comments.

## 5. Turnaround

- Aim to review within one working day. Unblock teammates over starting new work.
- Urgent hotfixes: expedited review, but still reviewed — see [Incident Response](../03_OPERATIONS/INCIDENT_RESPONSE.md).

## 6. Extra scrutiny areas

Payments, `rides` state machine, dispatch/matching, auth, and migrations get a **careful** review — these are where a subtle bug costs money, safety, or trust.
