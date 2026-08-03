# FILES — Event Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 05 of the FILES chain · **Stack:** transactional outbox (`outbox_events`)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _What does this module announce, what is in the payload, and what is the delivery guarantee?_
> **Traces from:** [01_BUSINESS](01_FILES_BUSINESS_REQUIREMENTS.md) §8 · [02_API](02_FILES_API_SPEC.md) §8 · [USER 05](../user/05_USER_EVENT_CATALOG.md) (envelope and classification)
> **Traces to:** 06_TEST_PLAN §6

---

## 1. Envelope — shared, unchanged

Same envelope, same outbox, same relay as AUTH and USER. The producer is `files`, registered in
`src/modules/files/events/catalog.ts` following the `USER_EVENT_CATALOG` pattern exactly.

```jsonc
{
  "eventId": "0198f2c1-…",
  "type": "file.uploaded",
  "producer": "files",
  "aggregateType": "file",
  "aggregateId": "0198f2c1-…",
  "subjectUserId": "0198a0b3-…",
  "requestId": "req_8f2c…",
  "occurredAt": "2026-08-02T10:15:22.418Z",
  "data": { … }
}
```

---

## 2. Classification

| Class           | Delivery                                       | Used here for               |
| --------------- | ---------------------------------------------- | --------------------------- |
| `audit`         | Durable, **committed in the same transaction** | privileged reads, deletions |
| `domain`        | Durable outbox; at-least-once to consumers     | uploads                     |
| `observability` | Best-effort in-process bus; may be dropped     | nothing in v1               |

`files` emits nothing on the observability tier. Every event here is either something a consumer
must react to or something compliance must be able to prove — neither survives being dropped.

---

## 3. The catalog

| Type              | Class    | Emitted when                                    |
| ----------------- | -------- | ----------------------------------------------- |
| `file.uploaded`   | `domain` | `PENDING → READY` — the bytes are verified      |
| `file.read`       | `audit`  | A **non-owner** mints a read URL (R-FILE-15)    |
| `file.deleted`    | `audit`  | A file is soft-deleted                          |
| `file.superseded` | `audit`  | A newer version replaces this one (R-FILE-31)   |
| `file.erased`     | `audit`  | The retention job destroys the object (phase 6) |

Four events. Notably **absent**:

| Not emitted             | Why                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `file.upload_requested` | A `PENDING` row is not a fact about the world — it is an intention that usually expires.               |
| `file.read` by an owner | Auditing every avatar render would drown the audit trail in noise (R-FILE-15 says _privileged_ reads). |
| `file.upload_failed`    | A rejected upload is a metric, not an event. No consumer can act on it.                                |
| `file.expired`          | The sweeper deleting an orphan is housekeeping. Nothing downstream cares.                              |

### 3.1 `file.uploaded`

```jsonc
{
  "fileId": "0198f2c1-…",
  "ownerUserId": "0198a0b3-…",
  "purpose": "DRIVER_DOCUMENT",
  "contentType": "image/jpeg",
  "sizeBytes": 842114,
}
```

Emitted in the same transaction as the `READY` transition (R-FILE-24). A rollback emits nothing;
exactly one event exists even when two callers complete concurrently (FILE-INV-6).

**Consumers:** `documents` (attach to a KYC record and enqueue review), `analytics` (upload volume
by purpose). Neither exists yet — the event ships now because the outbox is at-least-once and
consumers are added later without a producer change.

### 3.2 `file.read` — the privileged-access audit

```jsonc
{
  "fileId": "0198f2c1-…",
  "ownerUserId": "0198a0b3-…",
  "actorUserId": "0198cc41-…",
  "purpose": "DRIVER_DOCUMENT",
  "scope": "drivers:verify",
}
```

This is the module's compliance obligation, not a notification. Security 03 §63: _"viewing a KYC
document is audited"_ — reads of protected data, not just writes (NFR-SEC-03).

- Emitted **only** when `actorUserId != ownerUserId`.
- Written **before** the URL is returned. If the audit write fails, the read fails — an unauditable
  privileged read must not happen. This is the one place in the module where the audit is on the
  critical path, and deliberately so.
- Carries the **scope that authorized it**, so a later review can ask "who could do this, and
  should they still?"

### 3.3 `file.deleted`

```jsonc
{
  "fileId": "0198f2c1-…",
  "ownerUserId": "0198a0b3-…",
  "purpose": "PROFILE_IMAGE",
  "actor": "self", // "self" | "admin" | "system"
  "actorUserId": "0198a0b3-…",
}
```

`audit`, because a document disappearing before its review is exactly the sequence a dispute needs
reconstructed. The `actor`/`actorUserId` pair is the same shape USER's `user.account.restored`
uses — the _coarse_ actor for querying, the id for accountability.

### 3.4 `file.superseded`

```jsonc
{
  "fileId": "0198f2c1-…",
  "replacementFileId": "0198f9aa-…",
  "ownerUserId": "0198a0b3-…",
  "purpose": "DRIVER_DOCUMENT",
}
```

`audit`, and emitted **in the attaching module's transaction** (R-FILE-27) — so a failed attach
leaves the previous version current and announces nothing.

This is the event a KYC reviewer's queue must consume: a document under review that gets superseded
has to leave the queue, or an approval lands on a version nobody is presenting any more (03 §4A.2).

**Distinct from `file.deleted` on purpose.** A consumer that treats them alike will eventually treat
"the driver renewed their licence" as "the driver withdrew their licence", and those have opposite
compliance meanings.

### 3.5 `file.erased`

```jsonc
{
  "fileId": "0198f2c1-…",
  "purpose": "DRIVER_DOCUMENT",
  "action": "ARCHIVED", // "ARCHIVED" | "ERASED" — never conflated (03 §6)
  "retentionRule": "kyc_default",
}
```

The proof that retention ran. `action` distinguishes archival from destruction because
R-FILE-21 turns on that difference: for KYC and safety files, "we archive, we don't shred."

Carries no `ownerUserId` — by the time this fires, the point is that the subject's data is gone;
re-stating whose it was in a durable event would undercut the erasure.

---

## 4. Payload rules

Identical to USER 05 §5, with one addition specific to this module.

| Allowed                                              | Never                                               |
| ---------------------------------------------------- | --------------------------------------------------- |
| Identifiers (`fileId`, `ownerUserId`, `actorUserId`) | **A signed URL** (FILE-INV-2)                       |
| Coarse enums (`purpose`, `action`, `actor`)          | **A storage key** (R-FILE-7)                        |
| Counts and sizes (`sizeBytes`)                       | `fileName` — user-authored, frequently identifying  |
| MIME type                                            | Checksums — a content fingerprint of a private file |
| The authorizing `scope`                              | Bucket, region, provider                            |

**`fileName` is excluded on purpose.** It is the one field a reader would most expect, and it is the
one most likely to carry a personal value — `aadhaar-ayesha-1998.jpg` in an event stream is a leak
that no amount of downstream care undoes. Consumers that need a display name read it through the
API, under the read policy, where it is access-controlled.

---

## 5. Ordering and idempotency

- **At-least-once.** Consumers key on `eventId` and must be idempotent, per the platform rule.
- **No ordering guarantee across files.** Every payload is self-contained; nothing requires a
  consumer to have seen a previous event about the same file.
- `file.uploaded` for a given `fileId` is emitted **exactly once**, enforced by the conditional
  `PENDING → READY` update rather than by consumer deduplication (FILE-INV-6).
- A consumer that receives `file.deleted` for a file it never saw uploaded should treat it as a
  no-op — that ordering is legal.

---

## 6. Consumers

| Event             | Consumer    | Reacts by                                       | Exists? |
| ----------------- | ----------- | ----------------------------------------------- | ------- |
| `file.superseded` | `documents` | Pulling the old version out of the review queue | ⬜ stub |
| `file.uploaded`   | `documents` | Attaching to a KYC record, queueing review      | ⬜ stub |
| `file.uploaded`   | `analytics` | Upload volume by purpose                        | ⬜ stub |
| `file.read`       | `admin`     | Feeding the access-audit view                   | ⬜ stub |
| `file.deleted`    | `documents` | Marking the KYC record incomplete               | ⬜ stub |
| `file.erased`     | `admin`     | Retention compliance report                     | ⬜ stub |

**Every consumer is a stub today.** That is the intended state: the outbox decouples them, so the
producer ships complete and correct now, and each consumer attaches when its module is built without
touching this module at all.

---

## 7. Traceability

| Event            | Realizes                               | Proven by (06) |
| ---------------- | -------------------------------------- | -------------- |
| `file.uploaded`  | R-FILE-24, FILE-INV-6                  | §4, §6         |
| `file.read`      | R-FILE-15, NFR-SEC-03, Security 03 §63 | §5, §6         |
| `file.deleted`   | R-FILE-18, R-DATA-2                    | §6             |
| `file.erased`    | R-FILE-20/21/23                        | §6             |
| §4 payload rules | FILE-INV-2, NFR-10                     | §6             |
