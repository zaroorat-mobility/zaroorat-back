# FILES — Module Documentation

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Status:** 🟡 Specified (v1) — implementation pending
> **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02

This directory is the **FILES chain** — the same 01→06 discipline the [AUTH](../auth/) and
[USER](../user/) chains use.

AUTH answers _"is this person who they say they are?"_. USER answers _"who is this person?"_.
FILES answers **_"who is allowed to see these bytes, and for how long?"_**

---

## 1. The chain

Read in order. Each doc traces from the one before it; the last one proves the whole chain.

| Doc                                                                    | Answers                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [FLOW.md](FLOW.md)                                                     | What happens, step by step, in each file flow — the narrative overview.      |
| [01_FILES_BUSINESS_REQUIREMENTS.md](01_FILES_BUSINESS_REQUIREMENTS.md) | What the module must do, and why — vendor-agnostic.                          |
| [02_FILES_API_SPEC.md](02_FILES_API_SPEC.md)                           | Exact endpoints, request/response shapes, guard wiring, per-purpose policy.  |
| [03_FILES_DATABASE_SPEC.md](03_FILES_DATABASE_SPEC.md)                 | The model, the constraints the database enforces, the migration plan.        |
| [04_FILES_ERROR_CATALOG.md](04_FILES_ERROR_CATALOG.md)                 | Every failure on the wire, and how the client reacts.                        |
| [05_FILES_EVENT_CATALOG.md](05_FILES_EVENT_CATALOG.md)                 | Every event emitted, its payload, and its delivery guarantee.                |
| [06_FILES_TEST_PLAN.md](06_FILES_TEST_PLAN.md)                         | The tests that make all of the above provable.                               |
| [07_FILES_STORAGE_PROVIDER.md](07_FILES_STORAGE_PROVIDER.md)           | The `StorageProvider` contract — the only place a storage signature appears. |
| [08_FILES_CONFIGURATION.md](08_FILES_CONFIGURATION.md)                 | Every knob, its default, and what an unset value does.                       |
| [09_FILES_OPERATIONS.md](09_FILES_OPERATIONS.md)                       | Metrics, health, and the two scheduled jobs.                                 |

01–06 are the **specification**; 07–09 are the **implementation and operations contract**. Someone
deciding whether the module is right needs 01–06. Someone building it needs all nine.

There is no separate security spec (the AUTH `02` equivalent). FILES issues no credentials and
terminates no sessions — it consumes AUTH's gate. The security rules that **do** bind it (private
bucket, per-read signing, existence non-disclosure, audited privileged reads) are stated inline in
01 §5, enforced per 02 §4, and proven per 06 §5.

---

## 2. What this module owns

| Owns                                                     | Table   |
| -------------------------------------------------------- | ------- |
| Every uploaded object's metadata, lifecycle, and custody | `files` |
| The permission to upload, and the permission to read     | —       |
| The provider abstraction (`mock`, `s3`)                  | —       |

## 3. What it does **not** own

| Not owned                                       | Owner                   |
| ----------------------------------------------- | ----------------------- |
| What a document means, its expiry, its approval | `documents` / `drivers` |
| The ops review queue                            | `admin`                 |
| Authentication and the deny-by-default gate     | `auth`                  |
| Malware scanning, OCR, thumbnails               | deferred — 01 §11       |

FILES never reads a domain table and never learns what a driving licence is. It knows only: _this
file has this purpose, belongs to this user, and is `READY`._

---

## 4. The one rule

> **A domain row never holds a URL, only a file id. A URL is minted per read, for one reader, and it
> expires.**

Everything in 01–06 follows from that sentence. If a change would violate it, the change is wrong.

---

## 5. Status

**Built.** `src/modules/files/` holds the service, both providers (`mock` and `s3`), the reference
guard, the content inspector, and both jobs; `files` and its constraints are migrated; the
profile-image cutover landed in three deploys. What is still a `// Placeholder for Milestone 2` body
is `bootstrapStorage()`, so the readiness `storage` contributor 09 §3 specifies does not exist yet.

`src/core/storage/` and `src/integrations/aws-s3/` remain empty — the S3 client lives with the
module that uses it (13.5).

Phases and their order: [01 §12](01_FILES_BUSINESS_REQUIREMENTS.md#12-delivery-phases). Phase 6 was
blocked on a job runtime that did not exist; that runtime shipped (handbook volume 08) and both jobs
now run on the `files-maintenance` queue.

---

## 6. Why this module is next

From [IMPLEMENTATION_STATUS §11](../IMPLEMENTATION_STATUS.md): FR-FILES is **P0** in the MVP, and
`FR-ONBOARD` — the next feature group after it — cannot be specified coherently until file custody is
settled. Its central story ("a driver uploads documents; ops views them securely") is a file-custody
problem wearing a KYC hat.

It also closes a live defect: USER's profile-image allow-list is fail-closed with an empty default,
so **every** profile image URL is currently rejected. That is correct today and stops being a
limitation the moment this ships (FLOW §6).

---

## 7. Documentation inconsistencies this chain reports

Recorded rather than guessed, per the module-authoring rule. Detail in
[01 §13](01_FILES_BUSINESS_REQUIREMENTS.md#13-documentation-inconsistencies-found).

| #    | Finding                                                                    | Severity |
| ---- | -------------------------------------------------------------------------- | -------- |
| 13.1 | The schema stores URLs where FR-FILES requires signed access               | 🔴       |
| 13.2 | `06_Database/02`'s `kyc_documents` sketch diverges from the shipped schema | 🟡       |
| 13.3 | Two error-code conventions exist (`snake_case` vs `SCREAMING_SNAKE`)       | 🟡       |
| 13.4 | FR-FILES is P0 but its retention job has no runtime — _resolved_           | 🟡       |
| 13.5 | `src/core/storage/` and `src/integrations/aws-s3/` are empty               | 🟢       |

---

## 7C. Review response — round 5 (2026-08-02)

A fifth review asked for "a single per-purpose policy table developers can reference," noting that
everything else it listed was already documented.

**The table already existed — twice, and that was the actual defect.**

The same four columns (MIME, max size, max pixels, read TTL) lived in both 02 §5 and 08 §3, with
retention duplicated a third time in 03 §6. The proof it was a problem is in the previous round: the
read-TTL bug that violated R-FILE-16 existed in **both copies**, and fixing it meant editing both.
The round before that, verifying the two tables still agreed took a shell loop comparing them
row-by-row. A consistency check existing at all is the smell.

Collapsed to one home:

| Document  | Now holds                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| **02 §5** | **The authoritative table** — every per-purpose value, all eight columns                                             |
| 08 §3     | How those values are shaped in `file.config.ts`, and which two of six may be overridden (only in the safe direction) |
| 03 §6     | What **starts** each retention clock — a data question, and unique to it                                             |

No value now appears in two places. Every reference in 06 and 09 repointed to 02 §5.

### Also adopted

**The content-type → extension mapping** (02 §5.0), as an explicit table. The review asked for an
"allowed extensions" column; that would have been wrong — an extension is never validated, it is
_derived_ from the content-type magic bytes proved. Listing extensions as policy implies a check
against the client's string, which is exactly the check an attacker names their file to pass. The
mapping is documented as the one-way output it is.

### Declined

| Proposed column            | Why not                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed extensions         | An output, not an input — see above                                                                                                                                                                                                                 |
| Magic-byte validation Y/N  | `Yes` in every row. A constant column invites someone to make it vary                                                                                                                                                                               |
| Checksum required Y/N      | The server records a checksum regardless (R-FILE-10); a client-declared one is an optional extra transfer check, not a per-purpose policy                                                                                                           |
| Virus scan required Y/N    | `No` in every row for a feature deferred by FILES-OD-3                                                                                                                                                                                              |
| Upload URL TTL per purpose | Global 15 min. Nothing about a purpose changes how long a client needs to PUT                                                                                                                                                                       |
| Owner roles allowed        | Would misplace enforcement. FILES has **no role guard** (02 §3) — authorization is relational, and which role may upload a `DRIVER_DOCUMENT` is enforced by the attaching module. A column here would document a check this module does not perform |

**Value churn declined again** (VEHICLE_IMAGE 5→8 MB, DISPUTE 10→20 MB, tighter download TTLs). The
proposed 1–2 minute read TTLs would expire mid-read during a human ops review; 5 minutes is a floor
for anything a person reads rather than a client fetches.

---

## 7B. Review response — round 4 (2026-08-02)

A fourth review proposed relocating five settings and adding a sixth. **Four of the five were already
in the exact documents the review named** — but the sixth was a real gap, and checking the fifth
against the codebase found a live contradiction.

### Defect 1: the read TTLs violated R-FILE-16

R-FILE-16 requires every signed read TTL to be shorter than the access token that authorized it.
`src/config/jwt/jwt.config.ts:12` sets `accessTtlSeconds = 900` — **15 minutes**. The table gave
`PROFILE_IMAGE` and `VEHICLE_IMAGE` a **15-minute** read TTL.

Equal is not shorter. A URL minted early in a token's life outlived that token — exactly the window
the requirement exists to close. It was violated the moment the rule was written as prose in 01 and
the number in 08, with nothing connecting them.

Fixed: TTLs re-graded by sensitivity (10 / 5 / 2–3 min), **and** R-FILE-36 adds a startup assertion
that `max(readTtl) < jwtConfig.accessTtlSeconds` so the next person to tune `JWT_ACCESS_TTL_SECONDS`
finds out at boot instead of never (08 §3.0, §8.1).

### Defect 2: nothing bounded decoded image size

The review asked for maximum image dimensions. Genuinely missing — and it interacts with a
requirement of my own.

R-FILE-29 strips EXIF, which means **we decode uploaded images**. A 5 MB PNG can legally decode to
40,000 × 40,000 — 6.4 GB of RGBA. The size ceiling bounds bytes on the wire and says nothing about
what they become. My own EXIF requirement created the surface; nothing closed it.

Fixed: R-FILE-35, per-purpose pixel ceilings, and 02 §5.2 — dimensions are read from the **header**
before any decode, EXIF orientation is normalized first so a portrait photo is not measured
sideways, and PDFs are never parsed at all.

### Also adopted

**`image/webp` on every image allow-list.** Current Android screenshots and share sheets produce WebP
by default. Omitting it refused a user photographing their own licence for a reason they could not
act on.

### Already present, where the review said they should be

| Setting            | Review's proposed home | Actual location                          |
| ------------------ | ---------------------- | ---------------------------------------- |
| Allowed MIME types | 02                     | 02 §5 — already                          |
| Maximum file size  | 02                     | 02 §5 — already                          |
| Upload URL TTL     | 08                     | 08 §2 `STORAGE_UPLOAD_TTL_SEC` — already |
| Signed read TTL    | 08                     | 08 §3 — already (values now fixed)       |

### Declined

**Per-purpose MIME and size as environment variables.** A MIME allow-list is a security control; as
an env var it becomes runtime-mutable with no review, no diff, and no test run. It also does not vary
by environment — staging and production accept the same formats, which is what makes staging a
rehearsal. Reasoning in 08 §8.2; the policy/infrastructure split in §1 stands, as it does for
`userConfig` and `notificationConfig`.

**Size-value changes** (VEHICLE_IMAGE 5→8 MB, DISPUTE_EVIDENCE 10→20 MB) — no data either way, and
churning limits without it is noise. They are one config line when a real limit shows up.

---

## 7A. Review response — round 3 (2026-08-02) · **specification frozen**

A third review scored the chain 9.98/10, approved it for implementation, and recommended stopping
documentation. **Agreed — with one exception, because one item was a defect rather than a gap.**

### The defect: erasure did not erase

The review asked for an explicit bucket-versioning policy. Chasing that turned up a live
contradiction between this chain and platform policy:

- [11_Infrastructure/06](../11_Infrastructure/06_backups-and-dr.md) requires object storage to be
  **versioned**.
- On a versioned bucket, `DeleteObject` writes a **delete marker**; every prior version stays
  retrievable.
- Retention called `delete()` and set `erased_at`, and `file.erased` announced — durably, in the
  audit trail — that the bytes were gone.

**They would not have been.** An erasure requested under a privacy obligation would have been
recorded as honoured and silently not performed. My own 09 §6 stated the mechanism
("`delete()` is a delete-marker, not a purge") as a _reassurance about DR_ without noticing it
falsified R-FILE-23 and acceptance criterion 9.

Fixed: `StorageProvider` now has **`delete()` and `erase()`** as separate operations (07 §2), the
retention job calls `erase()` and never `delete()` (09 §4.2), and 08 §2.2 documents the trap plus
the required bucket state — versioning, public-access blocks, lifecycle, CORS, encryption.

This is exactly the class of bug that is cheap now and expensive after Phase 1 ships.

### Also adopted (both cheap, both real)

- **Worked key examples** (03 §5.1) — six concrete keys, plus the two shapes that fail and why.
- **Security review checklist** (06 §9A) — every row names the test that proves it, and the four
  rows that are bucket configuration rather than code say so.

### Declined

| Item                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage migration playbook in Phase 1 | The review itself concluded "leave ADR, no blocker." Agreed — 01 §2.4.                                                                                                                                                                                                                                                                                                                                       |
| KMS ownership / rotation policy       | Who holds the key is an org decision, not a module spec. 01 §2.4.                                                                                                                                                                                                                                                                                                                                            |
| DR drill runbook                      | Platform-owned; 09 §5 already contributes the FILES-specific runbook rows.                                                                                                                                                                                                                                                                                                                                   |
| Dashboard panel layout                | Metrics are specified (09 §2); panel arrangement is a Grafana artifact that belongs in Grafana.                                                                                                                                                                                                                                                                                                              |
| Cost monitoring (third time raised)   | `file.storage.bytes_total{purpose}` is the input; bytes→currency is a finance formula. 01 §2.4.                                                                                                                                                                                                                                                                                                              |
| Circuit breaker                       | The readiness probe already drains an unhealthy instance (09 §3); a breaker adds a second, unsynchronised source of truth about the same fact. Revisit if provider latency ever becomes the outage.                                                                                                                                                                                                          |
| 10-phase implementation plan          | Same defect as round 2's version: it puts **Tests at phase 8** and **Events at phase 7**. Events cannot follow the write that emits them — `file.uploaded` commits in the _same transaction_ as `READY` (R-FILE-24). And AUTH/USER earned 364 tests by testing each milestone, not by scheduling a testing phase. It also orders S3 before mock, though mock is what every test runs against. 01 §12 stands. |

### Status: frozen

Ten documents, 2,900 lines, three review rounds. The remaining suggestions are dashboards,
playbooks, and org policy — none changes an interface, a constraint, or an invariant. **Further
specification has negative value from here**; the next thing that will teach us something is Phase 1
running.

---

## 8. Review response — round 2 (2026-08-02)

A second review proposed 17 further items. One found a genuine hole in the model.

| Verdict                   | Items                                                                                         | Outcome                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Valid — model changed** | 1, 4 (versioning/replace), 13 (lifecycle), 3 (references)                                     | `SUPERSEDED` status, `superseded_by_id` chain, `archived_at`; R-FILE-31/32/33; FILE-INV-8/9; 03 §4A; FLOW §5A; `file.superseded`                                         |
| **Valid — documented**    | 7 (URL revocation), 11 (retries), 12 (idempotency TTL), 14 (matrix), 15 (folders), 16 (graph) | FILES-OD-14/15; 02 §2.1, §6A; 07 §8                                                                                                                                      |
| **Valid — future ADR**    | 5 (provider migration), 6 (KMS rotation), 8 (ownership transfer), 9 (cost)                    | [01 §2.4](01_FILES_BUSINESS_REQUIREMENTS.md#24-deferred-to-a-future-adr)                                                                                                 |
| **Already covered**       | 2 (locking)                                                                                   | The delete-while-referenced case is `FILE_IN_USE` / FILE-INV-5; the approve-stale-version race is now closed by supersession. The _review_ state belongs to `documents`. |
| **Declined**              | 10 (capacity alerts), 17 (phase re-cut)                                                       | See below                                                                                                                                                                |

**Item 13 was the real find.** My model had `deleted_at` and `erased_at` and no way to express
"deleted, archived to cold storage" — so a KYC file that retention had archived was indistinguishable
from one still awaiting the job. That is a compliance question the schema could not answer. Fixed
with `archived_at` plus a `CHECK` making archive and erase mutually exclusive.

**Item 1 was the biggest.** Nothing in the chain said what happens when a licence is renewed.
Deleting the old version would have destroyed the record of what the driver was operating under
before the renewal. Replacement is now a first-class transition, distinct from deletion, with the
version chain enforced as a line rather than a tree.

**Item 10 declined:** "bucket 80% full" is not a concept in object storage — S3 and every
S3-compatible service are unbounded. It applies only to a self-hosted MinIO volume, where it is a
disk alert owned by infrastructure, not by this module.

**Item 17 declined, and it would have caused harm.** The proposed re-cut makes "Phase 7: Tests" and
"Phase 5: Events". Both contradict how AUTH and USER were actually built: every milestone shipped
with its own tests, which is why those modules have 364 of them rather than a testing phase that
never arrived. And `file.uploaded` cannot follow `POST /complete` in a later phase — it is emitted in
the _same transaction_ as the `READY` transition (R-FILE-24). There is no intermediate version where
the write ships without the event. [01 §12](01_FILES_BUSINESS_REQUIREMENTS.md#12-delivery-phases) now
says so explicitly.

---

## 8A. Review response — round 1 (2026-08-02)

An earlier review proposed 23 additions. Assessed against the docs rather than accepted wholesale:

| Verdict                           | Items | Outcome                                                                                                                                                               |
| --------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Valid — adopted**               | 11    | Docs 07, 08, 09; R-FILE-28/29/30; FILES-OD-9/10/11/12; 02 §5.1                                                                                                        |
| **Already specified**             | 5     | Storage-key grammar (03 §5), MIME policy (02 §5), phase plan (01 §12), acceptance gate (01 §14 + 06 §3/§10), most sequence diagrams (FLOW §1–§3)                      |
| **Owned upstream**                | 2     | Backups + DR — [11_Infrastructure/06](../11_Infrastructure/06_backups-and-dr.md), see [09 §6](09_FILES_OPERATIONS.md#6-backups-and-disaster-recovery--owned-upstream) |
| **Declined — premature or YAGNI** | 5     | Extra provider classes (FILES-OD-12), virus-scan architecture (FILES-OD-3), image pipeline (FILES-OD-5), admin file operations, batch operations                      |

The three declined-as-premature items share one reason: **`admin` is a 2-line stub and M3 in the
release plan.** Specifying admin file search, preview, force-delete, and batch operations before the
module that would host them exists produces a contract with no implementer and no reviewer. The ops
_read_ path — which is the part that touches this module's security model — is already specified at
[02 §4](02_FILES_API_SPEC.md#4-the-read-policy) and audited at [05 §3.2](05_FILES_EVENT_CATALOG.md#32-fileread--the-privileged-access-audit).

Two items were half-right and the useful half was taken: the image-processing pipeline is declined,
but **EXIF stripping** from it is now R-FILE-29 — a JPEG's GPS coordinates would have disclosed a
rider's home address through their own avatar.

---

## 9. Naming note

Files here use `NN_FILES_TOPIC.md`, following the USER chain. The AUTH chain's `NN auth topic.md`
remains the outlier; per [USER README §5](../user/README.md), AUTH is the one that moves if the repo
ever standardizes.
