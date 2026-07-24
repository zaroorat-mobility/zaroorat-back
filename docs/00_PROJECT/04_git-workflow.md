# Git Workflow

**Owner:** Engineering · **Last reviewed:** 2026-07-06

We use **trunk-based development**: `main` is always releasable, work happens on short-lived
branches, and changes land via squash-merged pull requests. This keeps integration continuous
and avoids long-lived divergent branches that are painful to merge.

---

## Branch strategy

```
main ─────●───────●───────●───────●──────►  (always green, always deployable)
           \       \       \       \
            feat/…  fix/…   chore/… feat/…   (short-lived, hours to a few days)
```

- **`main`** — the trunk. Protected. No direct pushes. Every commit on `main` has passed CI
  and been reviewed. `main` is what deploys to staging automatically.
- **Feature branches** — branched off `main`, named `type/scope-summary`, live for **≤ 3 days**.
  If a branch lives longer, it's too big — split it.
- **Release** — we tag releases off `main` (`v1.4.0`). We do **not** keep a permanent
  `develop`/`release` branch (see [ADR 0002](adr/0002-trunk-based-development.md)).
- **Hotfix** — `fix/…` branched off `main`, fast-tracked review, tagged as a patch release.

### Branch name format

```
<type>/<scope>-<short-summary>
```

`type` ∈ `feat` · `fix` · `chore` · `refactor` · `docs` · `test` · `perf`.
`scope` is the domain (`rides`, `wallet`, `auth`, `admin`, `mobile`, `infra`).

Examples: `feat/rides-surge-pricing`, `fix/wallet-double-debit`, `chore/ci-cache-deps`.

---

## Commit messages — Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org). The format drives
automated changelogs and semver bumps.

```
<type>(<scope>): <summary in imperative mood, ≤ 72 chars>

<optional body: what & why, wrapped at 72 cols>

<optional footer: BREAKING CHANGE: …, Refs: #123>
```

Examples:

```
feat(rides): add surge multiplier to fare estimate

Surge is computed from live demand/supply ratio per zone and applied
before the platform fee. Capped at 3.0x per policy.

Refs: #482
```

```
fix(wallet): lock wallet row before debit to prevent double-spend
```

- **Imperative mood**: "add", not "added"/"adds". Reads as "this commit _will_ add…".
- **One logical change per commit** on a branch; the branch is **squashed** on merge, so the
  final `main` history is one clean commit per PR.

---

## Pull request lifecycle

```
open branch → push → open PR → CI runs → review → address → approve → squash-merge → auto-deploy staging
```

### PR rules

1. **Small PRs.** Target < 400 lines of diff. Large PRs get slower, worse reviews. Split them.
2. **Green CI is required** to merge — lint, types, tests, build all pass.
3. **≥ 1 approval** from a code owner (see `.github/CODEOWNERS`). Two for migrations, auth,
   payments, or infra.
4. **The PR description** uses the template: _what changed, why, how tested, screenshots/risk_.
5. **Squash merge only.** The PR title becomes the commit message, so it must be a valid
   Conventional Commit.
6. **You merge your own PR** once approved and green — the author owns the landing.
7. **Branches auto-delete** on merge.

### Definition of "ready to merge"

- [ ] CI green (lint, type, test, build)
- [ ] At least one approval (two for sensitive areas)
- [ ] No unresolved review comments
- [ ] Tests cover the change
- [ ] Docs/ADR updated if behavior or a decision changed
- [ ] DB migration included and reversible (if schema changed)

---

## Releases & versioning

- **SemVer** (`MAJOR.MINOR.PATCH`). Backend, mobile, and admin version independently but share
  the API-contract version they target.
- Releases are cut by tagging `main`: `git tag v1.4.0 && git push --tags`. CI builds and ships.
- Changelog is generated from Conventional Commit history.
- Full release process, rollout gates, and rollback live in **Volume 13 — Production Operations**.

---

## Day-to-day command cheatsheet

```bash
git switch main && git pull                     # start from fresh trunk
git switch -c feat/rides-surge-pricing          # new branch
# … work, commit in logical steps …
git push -u origin feat/rides-surge-pricing     # push & open PR
# … reviews …
git switch main && git pull                     # after merge, resync
```

Never `git push --force` to `main` or any shared branch. Force-push only to _your own_
feature branch, and prefer `--force-with-lease`.
