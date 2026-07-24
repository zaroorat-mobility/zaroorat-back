# Volume 1 — Project Foundation

> Everything an engineer needs to go from "just cloned the repo" to "shipped a reviewed
> change to production" — the mechanics of working in the Zaroorat Ride codebase.

**Owner:** Engineering · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                            | Topic                                          | Read it when…                             |
| -------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| [01_repository-structure.md](01_repository-structure.md)       | Monorepo layout & where things live            | You're lost finding a file                |
| [02_coding-standards.md](02_coding-standards.md)               | Python & TypeScript style, linting, formatting | Before your first PR                      |
| [03_naming-conventions.md](03_naming-conventions.md)           | Naming across code, DB, APIs, branches, files  | You're naming _anything_                  |
| [04_git-workflow.md](04_git-workflow.md)                       | Branching, commits, PRs, releases              | Every day                                 |
| [05_development-environment.md](05_development-environment.md) | Local setup, tooling, `.env`                   | Day one                                   |
| [06_docker-setup.md](06_docker-setup.md)                       | Local Docker Compose stack                     | You want the full stack running           |
| [adr/](adr/)                                                   | Architecture Decision Records                  | You're making or reviewing a big decision |

---

## The one-paragraph summary

We work in a **single monorepo** with three deployable apps (`backend`, `mobile`, `admin`)
plus shared packages and infra. We use **trunk-based development** with short-lived feature
branches and squash-merge into `main`. Python is formatted by **Ruff**, typed with **mypy**;
TypeScript by **ESLint + Prettier**, typed strictly. Every change goes through a PR with at
least one review and green CI. Local development runs on **Docker Compose**; you can also run
each app natively. Decisions of consequence are recorded as **ADRs**.

If you internalize only that paragraph, you'll fit in. The rest of this volume is the detail.
