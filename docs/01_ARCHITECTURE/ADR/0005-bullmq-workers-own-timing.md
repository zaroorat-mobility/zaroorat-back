# ADR-0005: BullMQ workers own all timing & async

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §7 · LLD §4.2, §7 · Workflows §3

## Context
The core loop has time-driven behavior — a dispatch offer must expire if a driver doesn't respond, a payment must be captured after completion, notifications must fan out. We cannot trust mobile clients to fire these events (they disconnect, background, or crash), and slow/external work must not block the request path or be lost on restart.

## Decision
We will run **BullMQ workers** (`src/workers/*`, deployed via `Dockerfile.worker`) that own all timing and async work: dispatch timeouts and re-offer, payment capture/payout/refund, notification fan-out, and cleanup sweeps. Jobs are **idempotent** and **retry with exponential backoff**, dead-lettering on exhaustion.

## Consequences
- **Positive:** deadlines are server-enforced, not client-hoped; slow/external calls leave the request path; a crashed worker resumes from the queue — no orphaned trips (NFR-9); async work scales independently.
- **Negative / trade-offs:** more processes to operate and monitor; jobs must be written idempotently and observably.
- **Follow-ups:** define retry/backoff and dead-letter handling per queue; monitor queue depth; alert on dead-letter growth.

## Alternatives considered
- **Client-side timers** — rejected: unreliable; drivers/riders disconnect.
- **In-process `setTimeout`** — rejected: lost on restart, doesn't scale across instances.
- **DB-polling cron** — rejected: higher latency and DB load than a queue.
