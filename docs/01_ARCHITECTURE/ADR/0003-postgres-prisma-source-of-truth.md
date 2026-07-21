# ADR-0003: PostgreSQL + Prisma as the source of truth

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Architecture, Engineering
- **Related:** HLD §5 · LLD §2 · NFR-5

## Context
Trips and money require strong consistency, transactional integrity, and an auditable trail. We also need geospatial queries for matching, and a type-safe data layer for a large domain shared between the API and workers.

## Decision
We will use **PostgreSQL** as the single system of record, accessed exclusively through **Prisma**. All schema changes go through committed, reviewed migrations (`prisma/schema.prisma` + `prisma/migrations`). Money and trip-state writes run in transactions.

## Consequences
- **Positive:** ACID guarantees for money/state; type-safe queries shared API↔worker; versioned migrations; Postgres supports geospatial and JSON; DB is the last line of defense (unique constraints, append-only tables).
- **Negative / trade-offs:** Prisma's query flexibility is narrower than raw SQL for some analytics — use read models where needed; migrations require review discipline.
- **Follow-ups:** repositories are the only DB touchpoint; schema.prisma is authoritative; never hand-edit migrations or the DB.

## Alternatives considered
- **MongoDB / document store** — rejected: weaker transactional guarantees for money and relational trip data.
- **Raw SQL / Knex** — rejected: loses end-to-end type safety across a large domain.
