# ADR-0002: Trunk-based development

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Engineering

## Context

We need a branching model. The team is small-to-mid sized and wants to ship frequently. The
classic alternative, Git Flow, maintains long-lived `develop`, `release`, and `feature`
branches, which for a fast-moving product tends to produce painful merges and delayed
integration.

## Decision

We will use **trunk-based development**: `main` is the single long-lived branch and is always
releasable. Work happens on short-lived branches (≤ 3 days) that squash-merge into `main`.
Releases are cut by tagging `main`.

## Alternatives considered

- **Git Flow.** Well-known, but the long-lived `develop`/`release` branches add merge overhead
  and slow integration. Overkill for our release cadence.
- **GitHub Flow / trunk-based (chosen).** Continuous integration into `main`, small PRs, feature
  flags for incomplete work. Simple mental model, fast feedback.

## Consequences

- ✅ Continuous integration — no big-bang merges.
- ✅ Simple model: branch, PR, squash, tag.
- ✅ Encourages small PRs and frequent shipping.
- ⚠️ `main` must be protected and always green — requires solid CI and required reviews.
- ⚠️ Incomplete-but-merged work needs **feature flags** rather than long-lived branches.
- ⚠️ Requires discipline to keep branches short-lived.
