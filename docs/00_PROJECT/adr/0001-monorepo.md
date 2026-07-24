# ADR-0001: Single monorepo for all apps

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Engineering

## Context

Zaroorat Ride ships three tightly-coupled applications — a FastAPI backend, an Expo mobile app,
and a React admin dashboard — plus shared code (API types, UI components) and infrastructure.
The backend defines API contracts that both clients consume. A single feature (e.g. surge
pricing) frequently touches all three at once. We need to decide whether these live in one
repository or several.

## Decision

We will keep **all applications, shared packages, and infrastructure in a single Git monorepo**
using package-manager workspaces (pnpm for JS, uv for Python).

## Alternatives considered

- **Polyrepo (one repo per app).** Clean ownership boundaries, but a contract change becomes a
  multi-repo, multi-PR dance with version-pinning and release-ordering pain. Cross-cutting
  changes can't land atomically, and "which versions are compatible?" becomes a standing question.
- **Monorepo (chosen).** One atomic PR can change the contract and both clients together. Shared
  code is imported, not published-and-consumed. Single CI config, single issue tracker, one
  place to search. Cost: needs tooling discipline (path-scoped CI, CODEOWNERS) to avoid becoming
  a tangle.

## Consequences

- ✅ Contract changes land atomically across backend + clients.
- ✅ Shared code (`packages/`) is trivial to consume and refactor.
- ✅ One CI pipeline, one set of conventions, one search surface.
- ⚠️ CI must be **path-scoped** — only build/test what changed, or pipelines get slow.
- ⚠️ Requires `CODEOWNERS` and clear module boundaries so ownership stays legible.
- ⚠️ Repo grows large over time; we'll revisit tooling (build cache) if CI times degrade.
