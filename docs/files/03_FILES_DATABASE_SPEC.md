# FILES — Database Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 03 of the FILES chain · **Stack:** Prisma 7 / PostgreSQL 17
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _What is stored, what the database itself refuses, and how we get there without downtime._
> **Traces from:** [01_BUSINESS](01_FILES_BUSINESS_REQUIREMENTS.md) §6, §10 · [02_API](02_FILES_API_SPEC.md) §5 · [06_Database](../06_Database/) conventions
> **Traces to:** 06_TEST_PLAN §4, §7

---

## 1. What this module owns

| Owns                                           | Table   |
| ---------------------------------------------- | ------- |
| Every uploaded object's metadata and lifecycle | `files` |

One table. FILES-OD-6: the lifecycle is identical across purposes and only policy differs, so
splitting per purpose would duplicate six copies of the same state machine.

It owns **no** foreign key into a domain table. The reference points the other way — `driver_documents`
holds a `file_id`, not the reverse — because a file must not need to know what attached it.

---

## 2. Placement

`prisma/schema/modules/file/file.prisma`, alongside the other thirteen module schemas. The enums go
in the same file rather than `shared/enums.prisma`: nothing outside this module branches on them,
and `shared` is for types two modules both need (`VerificationStatus` earns its place there;
`FileStatus` does not).

---

## 3. The model

```prisma
// ============================ FILE CUSTODY ============================

model File {
  id             String      @id @default(uuid(7)) @db.Uuid
  ownerUserId    String      @map("owner_user_id") @db.Uuid
  purpose        FilePurpose
  status         FileStatus  @default(PENDING)
  // Server-generated, unguessable, never reused, never returned (R-FILE-7, FILE-INV-1/2).
  storageKey     String      @map("storage_key")
  // Which provider wrote it. A bucket migration must not orphan rows written by the old one.
  storageProvider String     @map("storage_provider")
  // The client's name, kept for display only. Never part of the key, never trusted.
  fileName       String      @map("file_name")
  contentType    String      @map("content_type")
  // Declared at creation; overwritten with the verified value at completion (R-FILE-5).
  sizeBytes      Int         @map("size_bytes")
  checksumSha256 String?     @map("checksum_sha256")
  // When the write permission lapses. The sweeper reads this (R-FILE-22).
  uploadExpiresAt DateTime   @map("upload_expires_at")
  completedAt    DateTime?   @map("completed_at")
  createdAt      DateTime    @default(now()) @map("created_at")
  updatedAt      DateTime    @updatedAt @map("updated_at")
  // Soft delete. The object outlives this until retention erases it (R-FILE-18).
  deletedAt      DateTime?   @map("deleted_at")
  // Set when retention moves the bytes to cold storage. Distinct from erasure:
  // the object still exists (R-FILE-21). Mutually exclusive with erasedAt.
  archivedAt     DateTime?   @map("archived_at")
  // Set by the retention job once the object is actually gone (R-FILE-23).
  erasedAt       DateTime?   @map("erased_at")
  // The file that replaced this one (R-FILE-31). Forms a version chain; null on
  // the current version and on files that were deleted rather than replaced.
  supersededById String?     @unique @map("superseded_by_id") @db.Uuid

  owner       User  @relation(fields: [ownerUserId], references: [id])
  supersededBy File? @relation("FileVersion", fields: [supersededById], references: [id])
  supersedes   File? @relation("FileVersion")

  // FILE-INV-1 (§4.1). Expressible in Prisma, so it lives here rather than in
  // raw SQL; `map` keeps the name §4.1 publishes.
  @@unique([storageKey], map: "uq_files_storage_key")
  // Ownership scoping — every read filters on owner first (FILE-INV-4).
  @@index([ownerUserId], map: "ix_files_owner")
  // The sweeper's query: PENDING rows past their permission window. Partial index
  // in raw SQL (§4.2) — Prisma cannot express the WHERE clause.
  @@index([status, uploadExpiresAt], map: "ix_files_sweep")
  // The retention job's query: closed (deleted or superseded), no terminal
  // outcome yet. The partial form is in raw SQL (§4.6) — the predicate spans
  // three nullable columns and a status, which Prisma cannot express.
  @@index([status, deletedAt], map: "ix_files_retention")
  @@map("files")
}

enum FilePurpose {
  PROFILE_IMAGE
  DRIVER_DOCUMENT
  VEHICLE_DOCUMENT
  VEHICLE_IMAGE
  SOS_EVIDENCE
  DISPUTE_EVIDENCE
}

enum FileStatus {
  PENDING
  READY
  EXPIRED
  DELETED
  // Replaced by a newer version. NOT deleted: the bytes were valid evidence at
  // the time and retention keeps them for their full window (R-FILE-32).
  SUPERSEDED
}
```

### 3.1 Field notes

| Field                     | Why it is the way it is                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid(7)` — matches every other table, and its time-ordering keeps index writes append-mostly.                                                                |
| `storageKey`              | Never derived from `fileName` or `id`. A key derived from an id is guessable the moment an id leaks; a key derived from a filename invites traversal. See §5. |
| `storageProvider`         | Rows outlive vendors. Without this, switching providers silently repoints every historical key at a bucket that never held it.                                |
| `sizeBytes`               | `Int` caps at ~2.1 GB, an order of magnitude above the 50 MB ceiling. `BigInt` would buy nothing and cost every consumer a conversion.                        |
| `fileName`                | Display only. It is attacker-controlled text and is treated as such everywhere.                                                                               |
| `deletedAt` vs `erasedAt` | Two different facts: "no longer visible" and "the bytes are gone". Compliance needs to prove the second happened, and when.                                   |
| `purpose`                 | No `@updatedAt`-style mutability anywhere; the service never issues an update touching it (FILE-INV-7). §4.3 makes the database enforce that too.             |

### 3.2 What is deliberately absent

| Absent           | Why                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| The bytes        | FR-FILES ac-1. Postgres is not an object store; a `bytea` column would wreck backup and replication. |
| Any URL column   | FILES-OD-2 and R-FILE-12. A stored URL is either public or expired.                                  |
| `signedUrlCount` | Would make a metric into a write on every read, on the hottest path in the module.                   |
| A domain FK      | §1 — the reference points inward, not outward.                                                       |

---

## 4. Constraints the database enforces

Application checks are a courtesy; these are the guarantees.

### 4.1 Storage-key uniqueness — FILE-INV-1

```sql
CREATE UNIQUE INDEX uq_files_storage_key ON files (storage_key);
```

Total, not partial. A key must be unique across deleted and erased rows too — reuse after erasure
would let a stale signed URL resolve to somebody else's object.

**Expressed in Prisma, not raw SQL.** Unlike everything else in §4 this is a plain unique index on
one column, so it is `@@unique([storageKey], map: "uq_files_storage_key")` in the model — `map` keeps
the name this section publishes. Hand-writing it would put an object in the database that the schema
did not know about, for no benefit.

### 4.2 The sweeper's partial index — R-FILE-22

```sql
CREATE INDEX ix_files_sweep_pending ON files (upload_expires_at)
    WHERE status = 'PENDING';
```

The sweeper only ever asks one question. A partial index keeps it proportional to the orphan
backlog rather than to the table.

### 4.3 Legal states only — R-FILE-17, FILE-INV-3

```sql
-- A READY file has been verified: it must carry its completion time and its real size.
ALTER TABLE files ADD CONSTRAINT ck_files_ready_is_complete
    CHECK (status <> 'READY' OR (completed_at IS NOT NULL AND size_bytes > 0));

-- A retention terminal state implies the row left the read path first — by
-- deletion or by supersession. The reverse is fine (awaiting the job).
ALTER TABLE files ADD CONSTRAINT ck_files_terminal_implies_closed
    CHECK ((erased_at IS NULL AND archived_at IS NULL)
           OR deleted_at IS NOT NULL OR status = 'SUPERSEDED');

-- Archive and erase are opposite outcomes, never both (R-FILE-21).
ALTER TABLE files ADD CONSTRAINT ck_files_archive_xor_erase
    CHECK (archived_at IS NULL OR erased_at IS NULL);

-- A superseded file must name its replacement, and only a superseded file may.
ALTER TABLE files ADD CONSTRAINT ck_files_superseded_has_successor
    CHECK ((status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL));
```

`ck_files_archive_xor_erase` is what makes 05 §3.4's `action` field trustworthy: a row cannot claim
both outcomes, so a compliance report reading `archived_at` is reading a fact the database enforced
rather than a flag the application remembered to set.

`ck_files_ready_is_complete` is what makes FILE-INV-3 structural: a row cannot claim `READY` without
the evidence of completion, so "attach only `READY` files" cannot be satisfied by a forged state.

### 4.4 One live profile image per user — the USER cutover

```sql
CREATE UNIQUE INDEX uq_files_one_live_profile_image ON files (owner_user_id)
    WHERE purpose = 'PROFILE_IMAGE' AND status = 'READY' AND deleted_at IS NULL;
```

The same partial-unique shape as `uq_users_phone_active`. It makes "replacing an avatar replaces it"
a database fact: the old row must be soft-deleted in the same transaction that readies the new one,
or the insert fails. Without it, two concurrent avatar uploads leave two live images and the
resolution is whichever query happens to sort first.

### 4.5 One live version per (owner, purpose) chain — R-FILE-31

Two files must not name the same successor, or a version chain becomes a tree and "which version is
current?" has two answers. Two concurrent replacements of one licence is exactly how that happens.

**This one needs no raw SQL.** `supersededById String? @unique` in §3 already does it: Postgres
treats `NULL`s as distinct in a unique index, so every current file (successor `NULL`) coexists
freely while two rows naming the _same_ successor collide. The generated constraint is
`files_superseded_by_id_key`.

Worth stating because the instinct after §4.1–§4.4 is to reach for a partial index — here that would
be a second constraint enforcing what Prisma already emits.

> §4.4's `uq_files_one_live_profile_image` already excludes `SUPERSEDED` implicitly — it filters on
> `status = 'READY'`, and a superseded row is not `READY`.

### 4.6 The retention job's partial index

```sql
CREATE INDEX ix_files_retention_pending ON files (deleted_at)
    WHERE (deleted_at IS NOT NULL OR status = 'SUPERSEDED')
      AND erased_at IS NULL
      AND archived_at IS NULL;
```

Matches 09 §4.2's query exactly. Without the partial predicate the job scans every file ever
uploaded, on a table that only grows — and it runs nightly forever.

> Prisma expresses **§4.1 and §4.5** (a plain unique index and a `@unique` field). **§4.2, §4.3,
> §4.4, and §4.6 it cannot** — partial indexes and `CHECK` constraints have no Prisma equivalent — so
> those ship as raw SQL in the same migration as the table, exactly as `uq_saved_places_user_label`
> did.
>
> The rule this follows: anything the schema can model belongs in the schema, so `prisma migrate
diff` stays a true statement about the database. Only what Prisma genuinely cannot see is written
> by hand.

---

## 4A. Supersession — the replacement model (R-FILE-31/32)

A driver renews a licence. A rider changes their avatar. An RC expires and is reissued. **Every one
of these is a replacement, and none of them is a deletion.**

|                    | Deleted                | Superseded                                                                |
| ------------------ | ---------------------- | ------------------------------------------------------------------------- |
| Caused by          | The owner asked        | A newer version arrived                                                   |
| Read path          | Gone immediately       | Gone immediately                                                          |
| Retention clock    | Starts at `deleted_at` | Starts at **supersession**, but the window is the _purpose's_ full window |
| Compliance meaning | "The user withdrew it" | "This was valid until \<date\>"                                           |
| Version chain      | None                   | `superseded_by_id` → the replacement                                      |

**Why `SUPERSEDED` is not just `DELETED`.** A driver's previous licence is not junk — it is the
document that was on file for every trip taken before the renewal. If a regulator asks "what licence
was this driver operating under in March?", a soft-deleted row indistinguishable from a user-initiated
deletion cannot answer. The chain can.

### 4A.1 The operation

`files` exposes one method, called by the owning module **inside its own transaction** (R-FILE-27):

```ts
supersede(previousFileId: string, replacementFileId: string, tx: TransactionClient): Promise<void>
```

It refuses unless: both files exist, both belong to the same owner, both share a `purpose`, the
replacement is `READY`, and the previous is `READY` (not already superseded — that would fork the
chain, which §4.5 rejects at the database anyway).

It sets `status = 'SUPERSEDED'` and `superseded_by_id`, and emits `file.superseded` — all in the
caller's transaction, so a failed attach leaves the old version current.

### 4A.2 The race this closes

The review that prompted this section named it exactly:

```
driver uploads licence → admin opens review → driver replaces licence → admin approves the OLD file
```

Supersession makes the approval fail rather than succeed wrongly: the reviewer's approval names a
`file_id` that is now `SUPERSEDED`, and `assertReferenceable` refuses anything not `READY`
(FILE-INV-3). The admin sees a conflict and re-reviews the current version.

**The review-lock itself is not this module's.** Whether a document can be replaced _while_ under
review is a `documents` policy — FILES only guarantees that an approval can never silently land on a
stale version.

---

## 5. Storage-key construction

Not a database concern, but it is the value the unique index protects, so it is specified here.

```
{purposePrefix}/{yyyy}/{mm}/{uuidv4}{ext}
```

- `purposePrefix` — a two-letter code (`pi`, `dd`, `vd`, `vi`, `se`, `de`). Enables per-prefix
  bucket lifecycle rules and makes a stray object's class obvious in a console.
- `yyyy/mm` — keeps prefixes from growing unbounded, which matters for listing and for lifecycle.
- **`uuidv4`, not the row's `uuidv7`** — this is the one place the time-ordered id is wrong. A v7 id
  leaks its creation time and is adjacent to its neighbours; a key must be unguessable even to
  someone holding a different key (R-FILE-7).
- `ext` — from the **validated** content-type, never from `fileName`.

No user id appears in the key. Enumerating a user's uploads from object storage should be impossible
even for someone who can list the bucket.

### 5.1 Worked examples

```
pi/2026/08/8f14e45fceea167a5a36dedd4bea2543.jpg     # PROFILE_IMAGE
dd/2026/08/c9f0f895fb98ab9159f51fd0297e236d.pdf     # DRIVER_DOCUMENT
vd/2026/08/45c48cce2e2d7fbdea1afc51c7c6ad26.pdf     # VEHICLE_DOCUMENT
vi/2026/08/d3d9446802a44259755d38e6d163e820.webp    # VEHICLE_IMAGE
se/2026/08/6512bd43d9caa6e02c990b0a82652dca.mp4     # SOS_EVIDENCE
de/2026/08/c20ad4d76fe97759aa27a0c99bff6710.png     # DISPUTE_EVIDENCE
```

Read one and check what it does **not** tell you: no user id, no driver id, no original filename, no
document type beyond the coarse prefix, and no ordering relative to its neighbours. Someone holding
`dd/2026/08/c9f0…pdf` learns that a driver document was uploaded in August 2026 — and cannot derive
a second key, or work out whose it is, from it.

Contrast the shapes that fail: `drivers/8821/licence.pdf` leaks the driver id and lets you guess
`8821/rc.pdf`. `dd/2026/08/{files.id}.pdf` looks safe until an id appears in an API response or a
log, at which point the key is derivable — and because `id` is uuid**v7**, so are its neighbours'.

---

## 6. Retention

Per-purpose, config-driven (R-FILE-20), executed by the job in phase 6.

Windows and terminal actions are in
[02 §5](02_FILES_API_SPEC.md#5-per-purpose-policy--the-authoritative-table). What this table adds is
**what starts the clock** — which is a data question, and the one most easily got wrong.

| Purpose            | Clock starts at              | Basis                |
| ------------------ | ---------------------------- | -------------------- |
| `PROFILE_IMAGE`    | replaced, or account erased  | R-DATA-3             |
| `DRIVER_DOCUMENT`  | the driver relationship ends | R-KYC-5, R-FILE-21   |
| `VEHICLE_DOCUMENT` | vehicle retired              | R-KYC-5              |
| `VEHICLE_IMAGE`    | vehicle retired              | —                    |
| `SOS_EVIDENCE`     | incident closed              | R-SAFE-4, FR-DATA-01 |
| `DISPUTE_EVIDENCE` | dispute closed               | R-DATA-2             |

**Only `PROFILE_IMAGE` starts at anything this module can see.** Every other trigger is a fact owned
by `drivers`, `vehicles`, `sos`, or `support` — so retention cannot compute eligibility alone, and
the reference guard below is how it asks. A retention job that started every clock at upload would
archive an active driver's licence out from under them on its eighth anniversary.

**Archive ≠ delete.** Database 06 §60: "we _archive_, we don't shred what compliance or a dispute
may need." Archived objects move to a colder storage class; `erased_at` stays null because the bytes
still exist. Only `erase` sets it.

**The reference guard (R-FILE-19, FILE-INV-5).** Before erasing, the job asks the owning module
whether a live row still points at the file. `files` cannot answer this itself — it holds no FK by
design (§1) — so the check is an interface each consumer implements. Until `drivers` and `documents`
exist, the only registered consumer is `users`, and the only erasable purpose is `PROFILE_IMAGE`.

---

## 7. Migration plan

### 7.1 Phase 1 — create

`prisma/migrations/<ts>_add_files/migration.sql`

1. `CREATE TYPE "FilePurpose"`, `CREATE TYPE "FileStatus"`.
2. `CREATE TABLE files` with the FK to `users`.
3. The four indexes/constraints from §4.

Additive only. No existing table is touched, so it is safe under a rolling deploy with no
coordination.

### 7.2 Phase 7 — the profile-image cutover (expand → migrate → contract)

`user_profiles.profile_image` is a live `String?` URL column written by running code. It becomes a
file reference **without a rename under running code**, per Database 06's expand→contract rule.

| Deploy | Schema                                                       | Code                                                       |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **1**  | `ADD COLUMN profile_image_file_id UUID REFERENCES files(id)` | Writes both; reads the old column. Old code is unaffected. |
| **2**  | —                                                            | Reads the new column, falls back to the old when null.     |
| **3**  | `DROP COLUMN profile_image`                                  | New column only.                                           |

There is no backfill: the old column holds URLs pointing at hosts that were never trusted
(`userConfig.profileImageHosts` defaults to empty, so **every** value it could hold was rejected at
write time — the column is empty in practice). Deploy 2 can therefore ship the same day as deploy 1.

**This also closes USER §8.5.** With images in a private bucket behind signed reads, the host
allow-list has nothing left to guard, and `profileImageHosts` is deleted along with the column.

### 7.3 `driver_documents` / `vehicle_documents` / `vehicle_images`

`file_url String` → `fileId String @db.Uuid` with an FK. No expand→contract needed: no code reads or
writes these tables, so the change is a straight edit. It is **not** part of this module's phases —
it belongs to whichever milestone builds `documents`, and is recorded here only so that module
inherits the decision rather than re-litigating it. See [01 §13.1](01_FILES_BUSINESS_REQUIREMENTS.md#131-the-schema-stores-urls-where-this-module-requires-references-).

---

## 8. Query patterns

Every query in the module, and the index it rides.

| Query                                | Index                             | Caller          |
| ------------------------------------ | --------------------------------- | --------------- |
| Load one file by id, owner-scoped    | PK + `ix_files_owner`             | every endpoint  |
| `PENDING → READY` conditional update | PK                                | complete (§2.2) |
| Orphan sweep                         | `ix_files_sweep_pending`          | sweeper         |
| Retention candidates                 | `ix_files_retention_pending`      | retention job   |
| Live profile image for a user        | `uq_files_one_live_profile_image` | USER cutover    |

No query in this module scans without an index, and none is unbounded — the two job queries are both
`LIMIT`-batched.

---

## 9. Traceability

| Section | Realizes                          | Proven by (06)  |
| ------- | --------------------------------- | --------------- |
| §3      | R-FILE-3, 7, 10, 18               | §7 schema tests |
| §4.1    | FILE-INV-1                        | §4              |
| §4.3    | R-FILE-17, FILE-INV-3             | §4              |
| §4.4    | FILE-INV-6-adjacent, USER cutover | §4, §7          |
| §5      | R-FILE-7, FILE-INV-2              | §5              |
| §6      | R-FILE-19..21, FILE-INV-5         | §6              |
| §7      | Database 06 expand→contract       | §7              |
