# ADR-0008: Idempotency on all money/critical writes

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §8 · LLD §4.4 · NFR-6 · BR-2

## Context
Mobile clients on unreliable networks retry requests; workers retry failed jobs. Without protection, a retried "charge", "accept offer", or "payout" could execute twice — a double charge or double payout. A double charge is worse for trust than a slow response (BRD risk register).

## Decision
We will require an **`Idempotency-Key`** on all money-mutating and non-idempotent POSTs, enforced by `middleware/idempotency.ts`: a seen key returns the stored response without re-executing. As a backstop, `Payment.idempotencyKey` carries a **DB unique constraint**, and worker jobs are keyed so re-runs are no-ops. Money writes run in transactions with an append-only `LedgerEntry`.

## Consequences
- **Positive:** retries are safe end-to-end (client → API → worker); the DB is the final guarantee against duplication; ledger is auditable.
- **Negative / trade-offs:** clients must generate and send keys; the API must persist request→response mappings with a sensible TTL.
- **Follow-ups:** define key format, storage, and TTL; document which endpoints require the header (see LLD §5); ensure all money worker jobs are keyed.

## Alternatives considered
- **Best-effort dedup by timestamp** — rejected: racy, not reliable under concurrency.
- **No idempotency, rely on client discipline** — rejected: guarantees eventual double-charges.
