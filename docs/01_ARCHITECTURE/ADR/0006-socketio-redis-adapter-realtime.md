# ADR-0006: Socket.io + Redis adapter for realtime

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §6 · LLD §5 · Workflows §5

## Context

Riders and drivers need live updates: driver location on the map, trip state changes, in-trip chat, and SOS. Clients are on flaky mobile networks (reconnects, duplicates). The API runs as multiple horizontally scaled instances, so a rider on instance B must receive updates from a driver on instance A.

## Decision

We will use **Socket.io** for the real-time layer, backed by the **Redis adapter** so rooms are shared across API instances. State is **server-authoritative**: the DB decides trip state; sockets push it; clients reconcile via REST (`GET /rides/:id`) on reconnect. All socket handlers are **idempotent**.

## Consequences

- **Positive:** rooms/reconnection handled by the library; horizontal scale via Redis pub/sub; duplicate messages are safe; reconnect reconciliation prevents split-brain state.
- **Negative / trade-offs:** Socket.io protocol overhead vs. raw WebSocket; the Redis adapter is a shared dependency to operate.
- **Follow-ups:** define rooms (`trip:{id}`, zone channels), presence TTLs, and reconnect reconciliation on the client contract.

## Alternatives considered

- **Raw WebSocket** — rejected: we'd rebuild rooms, reconnection, and fan-out ourselves.
- **Server-Sent Events / long-poll** — rejected: one-directional / higher latency; chat and location need bidirectional.
