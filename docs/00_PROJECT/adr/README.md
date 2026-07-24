# Architecture Decision Records (ADRs)

An ADR captures **one significant decision**: the context, the choice we made, and the
consequences. ADRs are immutable once accepted — if we change our mind, we write a _new_ ADR
that supersedes the old one. This gives future engineers the _why_ behind the system, which
code alone never explains.

## When to write an ADR

Write one when a decision:

- Is expensive or painful to reverse (database choice, auth model, sync vs async).
- Affects multiple teams or modules.
- Rejects a reasonable alternative someone will later ask "why didn't we just…?".

Not every choice needs an ADR. A local implementation detail doesn't. "Which state library
does the whole mobile app use?" does.

## Process

1. Copy [`template.md`](template.md) to `NNNN-short-title.md` (next number, zero-padded).
2. Open it as **Proposed** in a PR. Discussion happens in the PR.
3. On merge it becomes **Accepted**.
4. To reverse it later, write a new ADR that marks this one **Superseded by ADR-NNNN**.

## Index

| ADR                                                    | Title                                                                          | Status   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | -------- |
| [0001](0001-monorepo.md)                               | Single monorepo for all apps                                                   | Accepted |
| [0002](0002-trunk-based-development.md)                | Trunk-based development                                                        | Accepted |
| [0003](0003-postgis-for-geo.md)                        | PostgreSQL + PostGIS for geospatial data                                       | Accepted |
| [0004](0004-modular-monolith.md)                       | Modular monolith backend (not microservices at launch)                         | Accepted |
| [0005](0005-geospatial-sharding-consistent-hashing.md) | Sharded matching tier via consistent hashing + geospatial sharding (evolution) | Accepted |
