# Zaroorat Ride — Engineering Handbook

> The single source of truth for how Zaroorat Ride is designed, built, run, and evolved.
> If a new engineer reads this handbook top to bottom, they should be able to ship
> production code with confidence and without tapping anyone on the shoulder.

**Status:** Living document · **Owner:** Engineering · **Last reviewed:** 2026-07-06

---

## What Zaroorat Ride is

Zaroorat Ride is a ride-hailing platform (riders ↔ drivers) built as a set of services:

| Layer            | Technology                                                     |
| ---------------- | -------------------------------------------------------------- |
| Backend API      | Python 3.12 · **FastAPI** · SQLAlchemy 2.x · Pydantic v2       |
| Realtime         | WebSockets · Redis Pub/Sub                                     |
| Datastore        | **PostgreSQL 16 + PostGIS** (geo) · **Redis 7** (cache/queues) |
| Rider/Driver app | **Expo · React Native** (TypeScript)                           |
| Admin dashboard  | **React + Vite + Tailwind** (TypeScript)                       |
| Infra            | Docker · Nginx · GitHub Actions · Kubernetes                   |

---

## How this handbook is organized

Documentation is split into **volumes**. Each volume is a folder, each folder has its
own `README.md` that acts as its table of contents. Read the volume you need; you do not
need to read them in order after Volume 1.

| #   | Volume                  | Folder               | Answers the question…                          | Status     |
| --- | ----------------------- | -------------------- | ---------------------------------------------- | ---------- |
| 1   | Project Foundation      | `00_Project/`        | How do we set up, structure, and work in code? | ✅ Done    |
| 2   | Business Documentation  | `01_Business/`       | Why does this product exist? Who is it for?    | ⬜ Planned |
| 3   | Product & Requirements  | `02_Product/`        | What exactly are we building? (PRD/SRS)        | ⬜ Planned |
| 4   | High-Level Architecture | `04_Architecture/`   | How do the pieces fit together?                | ⬜ Planned |
| 5   | Low-Level Design        | `05_Design/`         | How does each module work internally?          | ⬜ Planned |
| 6   | Database Design         | `06_Database/`       | How is data modeled, stored, indexed?          | ⬜ Planned |
| 7   | API Design              | `07_API/`            | What are the contracts? REST + WebSocket.      | ⬜ Planned |
| 8   | Mobile Architecture     | `08_Mobile/`         | How is the Expo app structured?                | ⬜ Planned |
| 9   | Admin Dashboard         | `09_Admin/`          | How is the React admin built?                  | ⬜ Planned |
| 10  | Backend Architecture    | `10_Backend/`        | How is the FastAPI service structured?         | ⬜ Planned |
| 11  | Infrastructure & DevOps | `11_Infrastructure/` | How do we containerize, deploy, scale?         | ⬜ Planned |
| 12  | Testing Strategy        | `13_Testing/`        | How do we prove it works?                      | ⬜ Planned |
| 13  | Production Operations   | `14_Operations/`     | How do we run it at 3am when it breaks?        | ⬜ Planned |
| 14  | Security                | `15_Security/`       | How do we keep it safe?                        | ⬜ Planned |

> Folder numbering leaves gaps (03, 12, 16–20) on purpose — reserved for volumes we will
> add (AI/matching, data/analytics, sharing/referrals, internal tooling) without renumbering.

---

## Conventions used in every document

- **Decisions** that shape the system are captured as ADRs — see `00_Project/adr/`.
- **Diagrams** are written as [Mermaid](https://mermaid.js.org) inside Markdown so they
  live in version control and diff cleanly. No binary `.png` boxes-and-arrows in git.
- **"MUST / SHOULD / MAY"** are used in the [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
  sense when stating rules.
- Every doc has an **owner** and a **last-reviewed date** in its header. A doc older than
  6 months without review is considered stale and flagged in review.

---

## Start here

New to the codebase? Read these four, in order:

1. [`00_Project/01_repository-structure.md`](00_Project/01_repository-structure.md)
2. [`00_Project/05_development-environment.md`](00_Project/05_development-environment.md)
3. [`00_Project/02_coding-standards.md`](00_Project/02_coding-standards.md)
4. [`00_Project/04_git-workflow.md`](00_Project/04_git-workflow.md)

You should have the stack running locally within ~30 minutes of finishing #2.
