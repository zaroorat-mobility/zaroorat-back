# Git Workflow

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20

## 1. Branching
- `main` is **always deployable**. No direct pushes — protected branch.
- Branch per unit of work: `type/short-description`
  - Types: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`.
  - Example: `feat/dispatch-timeout-worker`.
- Keep branches short-lived; rebase on `main` frequently to avoid drift.

## 2. Commits
- **Conventional Commits:** `type(scope): summary`
  - `feat(payments): add idempotent charge capture`
  - `fix(rides): reject late accept after reassignment`
- Imperative mood, present tense. One logical change per commit.
- Commit messages explain **why** when it isn't obvious from the diff.
- Never commit secrets, `.env`, credentials, or large binaries.

## 3. Pull requests
- Every change lands via PR → review → green CI → merge. No exceptions.
- PR description states: **what**, **why**, and **how to test**; links the issue/FR.
- A behavior change **updates its docs in the same PR** (docs live with code).
- Keep PRs small and focused — one concern per PR. Large PRs get split.
- Draft PRs are welcome for early feedback.

## 4. Required checks before merge
- [ ] Lint + format pass (`eslint`, `prettier`).
- [ ] Type check passes (`tsc --noEmit`).
- [ ] Tests pass; new logic has tests ([Testing](./TESTING_GUIDE.md)).
- [ ] Migration reviewed if the schema changed ([Database Guide](../01_ARCHITECTURE/DATABASE_GUIDE.md)).
- [ ] At least one approving review ([Code Review](./CODE_REVIEW.md)).

## 5. Merging
- **Squash-merge** to `main` (clean, linear history). The squash message follows Conventional Commits.
- Delete the branch after merge.
- Never merge with a red pipeline; never `--no-verify` to skip hooks unless explicitly agreed.

## 6. Migrations & Git
- Prisma migrations are **committed** and **immutable** once merged. Never edit a merged migration or the DB by hand ([ADR-0003](../01_ARCHITECTURE/ADR/0003-postgres-prisma-source-of-truth.md)).
- A migration and the code that depends on it land together.

## 7. Releases & hotfixes
- Tag releases from `main` (`vMAJOR.MINOR.PATCH`).
- Hotfix: `fix/…` off `main`, fast-tracked review, then tag. Follow the [Release Checklist](../03_OPERATIONS/RELEASE_CHECKLIST.md).
