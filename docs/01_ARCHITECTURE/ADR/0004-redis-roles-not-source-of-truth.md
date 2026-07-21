# ADR-0004: Redis for cache/queues/pubsub/geo, never source of truth

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §5, §6 · Architecture Reference §4

## Context
We need low-latency caching, a backing store for background jobs, a pub/sub layer to share Socket.io rooms across API instances, rate-limit counters, and hot storage for driver presence/geo. These are ephemeral, high-churn, loss-tolerant needs — the opposite of money and trip state.

## Decision
We will use **Redis** for caching, BullMQ queues, the Socket.io adapter, rate limiting, and hot geo/presence data. Redis is **never** authoritative for money or trip state; if Redis and Postgres disagree, **Postgres wins**.

## Consequences
- **Positive:** one well-understood dependency serves several needs; low latency; horizontal socket scale via the adapter; Redis data is reconstructable from Postgres.
- **Negative / trade-offs:** must resist the temptation to treat cached/geo data as authoritative; TTLs and eviction must be designed so staleness is safe (e.g. stale locations excluded from matching).
- **Follow-ups:** define TTLs for presence/geo, OTP, and idempotency keys; reconcile clients to DB on reconnect.

## Alternatives considered
- **Separate systems per need (Memcached + SQS + …)** — rejected: more moving parts, no benefit at our scale.
- **Redis as primary trip store** — rejected: unacceptable durability/consistency for money and state.
