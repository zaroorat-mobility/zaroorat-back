# FILES — Test Plan

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 06 of the FILES chain · **Stack:** `node:test` via `tsx --test`
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _What makes every claim in 01–05 provable rather than asserted?_
> **Traces from:** all of 01–05
> **Traces to:** the suite itself

---

## 1. Levels and tooling

Same harness as AUTH and USER — no new dependency, no new runner.

| Level           | Runner                                             | Boundary                                          |
| --------------- | -------------------------------------------------- | ------------------------------------------------- |
| **Unit**        | `node:test`, no I/O                                | Policy, validation, magic bytes, key construction |
| **Integration** | `node:test` + Postgres + Redis + **mock provider** | Real HTTP through `app.inject`, real transactions |

**The mock provider is the point.** `StorageProvider` has a `mock` implementation (FILES-OD-7),
mirroring `notifications`' `mock`/`msg91` split. It stores objects in an in-process `Map`, signs
URLs it can verify, and can be told to fail. This is what lets the whole module — including
completion validation and TTL expiry — be tested with **no bucket and no network**, which is also
what makes acceptance criterion #10 (swap provider by config) demonstrable.

---

## 2. What the mock provider must support

Because the suite's honesty depends on it:

| Capability                                                        | Needed by                                       |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| Store/retrieve/delete by key, **with a version list**             | everything; proving `erase` clears all versions |
| `head(key)` → size + first bytes                                  | completion validation (§3 #2)                   |
| Sign a URL with an explicit expiry, and **reject an expired one** | §5 TTL tests                                    |
| Sign scoped to one key + method                                   | §5 scope tests                                  |
| Inject a failure on any call                                      | §5 fail-closed tests                            |
| A clock seam                                                      | TTL expiry without `setTimeout` (see §8)        |

---

## 3. Acceptance-criteria matrix (01 §14 — the ship gate)

Every row green for v1. IDs map 1:1 to the eleven criteria.

| #   | Criterion                                                     | Level                    | Key assertions                                                                                           |
| --- | ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | No byte transits the API                                      | integration              | No route accepts a body over the JSON limit; the provider records zero writes from the API process       |
| 2   | Renamed executable refused at completion, object removed      | integration              | PUT ELF bytes as `image/jpeg` → `422 CONTENT_MISMATCH`; provider no longer holds the key; row `EXPIRED`  |
| 3   | No URL or key in any response, event, or log                  | integration              | Grep every response body, every `outbox_events.payload`, and captured log output                         |
| 4   | Another user's id is indistinguishable from a nonexistent one | integration              | Byte-identical `404` after stripping `requestId`                                                         |
| 5   | Ops read of a KYC doc writes an audit record                  | integration              | `file.read` in `outbox_events` with actor, file, purpose, scope                                          |
| 6   | A read URL stops working after its TTL                        | integration              | Mint → advance the provider clock past expiry → provider rejects                                         |
| 7   | A non-`READY` file can never be referenced                    | unit + integration       | Reference check refuses `PENDING`/`EXPIRED`/`DELETED`; `ck_files_ready_is_complete` refuses a forged row |
| 8   | Two concurrent completions → one `READY`, one event           | integration (concurrent) | `Promise.all`; both `200`, exactly one `file.uploaded`                                                   |
| 9   | Delete hides immediately, erases only on schedule             | integration              | Post-delete read → `404`; provider still holds the object; `erased_at` null                              |
| 10  | Provider swap is config-only                                  | integration              | The same suite passes against a second provider implementation, unchanged                                |
| 11  | `prisma validate`, typecheck, lint, full suite                | CI                       | All green                                                                                                |

---

## 4. Invariant tests (01 §10 — structurally impossible to violate)

These target the data and enforcement layer. Two must hold **under concurrency**.

| Invariant      | Test                                                                                                                                                                                                              | Level                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **FILE-INV-1** | Two rows cannot share a `storage_key`, including when one is erased — `uq_files_storage_key` raises                                                                                                               | integration                  |
| **FILE-INV-2** | No signed URL or storage key in any response body, event payload, or log line                                                                                                                                     | integration (sweep)          |
| **FILE-INV-3** | `UPDATE files SET status='READY'` without `completed_at` is refused by `ck_files_ready_is_complete`                                                                                                               | integration (raw SQL)        |
| **FILE-INV-4** | Owner / non-owner / soft-deleted / nonexistent all produce identical `404`s                                                                                                                                       | integration                  |
| **FILE-INV-5** | Erasure of a file a live row references is refused; `DELETE` returns `409 FILE_IN_USE`                                                                                                                            | integration                  |
| **FILE-INV-6** | `cap+n` simultaneous completions → exactly one `READY` transition, exactly one event                                                                                                                              | **integration (concurrent)** |
| **FILE-INV-7** | No code path updates `purpose`; a raw update is caught by the schema test                                                                                                                                         | unit + integration           |
| **FILE-INV-8** | Two files cannot name the same successor (`files_superseded_by_id_key`); a `SUPERSEDED` row with no successor is refused by `ck_files_superseded_has_successor`; **concurrent replacements yield one chain head** | integration (concurrent)     |
| **FILE-INV-9** | `archived_at` and `erased_at` are never both set — `ck_files_archive_xor_erase` raises                                                                                                                            | integration (raw SQL)        |

Plus the partial-unique proof, in the shape AUTH's `uq_user_role_active` test uses:

- **`uq_files_one_live_profile_image`:** a second live `PROFILE_IMAGE` for the same user is rejected
  **by the database**; soft-deleting the first makes the insert succeed; and `cap+5` concurrent
  avatar uploads leave exactly one live row.

---

## 5. Security suite

| Property                   | Test                                                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private by default         | Every route 401s unauthenticated; no route sets `config: { public: true }` (asserted against the route table)                                                                                                                                                         |
| URL scope                  | An upload URL cannot read; cannot touch a second key; cannot change method                                                                                                                                                                                            |
| URL TTL                    | Expired signature rejected by the provider; a read URL's TTL < the access token's (R-FILE-16)                                                                                                                                                                         |
| Existence non-disclosure   | §4 FILE-INV-4, plus: response **shape and status** identical, not merely the code                                                                                                                                                                                     |
| Magic-byte enforcement     | A table-driven case per row of [02 §5](02_FILES_API_SPEC.md#magic-byte-enforcement-r-file-5), each declared type fed the wrong bytes                                                                                                                                  |
| Key unguessability         | 1,000 generated keys: no user id, no file id, no filename substring; all distinct                                                                                                                                                                                     |
| Path traversal             | `fileName` of `../../etc/passwd` never reaches the key; the stored key still matches the §5 grammar                                                                                                                                                                   |
| Rate-limit axes            | Each axis in 02 §6 trips independently; strictest wins; `retryAfterSec` mirrors `Retry-After`                                                                                                                                                                         |
| Fail-closed                | Provider down → `503` on sign, complete, and read; **never** `200` with a null URL                                                                                                                                                                                    |
| Audit-on-the-critical-path | Audit write fails → the read fails; **no URL is returned** (05 §3.2)                                                                                                                                                                                                  |
| No-secrets-in-errors       | Every code in 04 §2 asserted to omit URLs, keys, bucket names, and provider prose                                                                                                                                                                                     |
| Erase clears every version | Overwrite a key three times on the versioned mock, `erase()`, assert **zero** versions and no delete marker. The same sequence with `delete()` must **leave** the earlier versions — otherwise the mock does not model the trap and the test proves nothing (08 §2.2) |
| Decompression bomb         | A ~4 KB PNG declaring 40,000 × 40,000 → `413` at completion, **without the process allocating for it**. Assert dimensions were read from the header (the decoder is never entered) and peak RSS stays flat (R-FILE-35, 02 §5.2)                                       |
| EXIF orientation first     | A 6000 × 4000 portrait JPEG with orientation 6 passes a 6000 × 6000 ceiling — it must be normalized before measuring, not refused as 4000 × 6000                                                                                                                      |
| Read TTL < token TTL       | Startup assertion: set `JWT_ACCESS_TTL_SECONDS` below the longest purpose TTL and the app **fails to boot** (R-FILE-36, 08 §8.1)                                                                                                                                      |

---

## 6. Event-contract tests

| Assertion                                                                                              | Level              |
| ------------------------------------------------------------------------------------------------------ | ------------------ |
| Each endpoint emits exactly the events 02 §8 / 05 §3 list, with the shared envelope                    | integration        |
| `file.uploaded` is written in the **same transaction** as the `READY` transition (rollback ⇒ no event) | integration        |
| `file.read` fires **only** for a non-owner, and carries the authorizing scope                          | integration        |
| No payload carries a URL, a key, a checksum, or a `fileName` (05 §4)                                   | unit + integration |
| `file.erased` distinguishes `ARCHIVED` from `ERASED`                                                   | unit               |
| An unlisted event type throws rather than publishing                                                   | unit               |

The last one is the `USER_EVENT_CATALOG` precedent: `userEvent()` throws on an unknown type because
an unlisted event is a contract breach, not a runtime condition.

---

## 7. Schema and migration tests

| Assertion                                                                                        |
| ------------------------------------------------------------------------------------------------ |
| All four §4 objects from [03](03_FILES_DATABASE_SPEC.md) exist, with the documented names        |
| `uq_files_storage_key` is **total**, not partial                                                 |
| `ix_files_sweep_pending` carries its `WHERE status = 'PENDING'` clause                           |
| Both `CHECK` constraints reject their illegal rows via raw SQL                                   |
| The `files` → `users` FK exists                                                                  |
| The profile-image cutover's deploy-1 migration is additive (old code still passes its own suite) |

The last row is what makes 03 §7.2's expand→contract claim testable rather than aspirational: the
USER suite must pass **unchanged** against the deploy-1 schema.

---

## 8. Two limits stated, not faked

**Signed-URL expiry is the provider's clock.** `node:test`'s `mock.timers` is restricted here to
`Date` (ioredis and Prisma need real timers), and against a real provider the expiry is enforced
remotely. So §3 #6 is proven against the **mock provider's injectable clock**, which is honest about
what it covers: our TTL arithmetic and our refusal to reuse URLs. That a real S3 signature expires
on time is AWS's contract, not ours, and testing it in CI would be testing AWS.

**Phase 6 has no runtime.** The sweeper and retention job are tested as **services, called
directly** — the same way `AccountService.restore()` is tested in USER, which also has no HTTP
caller. What is _not_ covered is that a scheduler invokes them, because no scheduler exists
([01 §13.4](01_FILES_BUSINESS_REQUIREMENTS.md#134-fr-files-is-p0-but-depends-on-a-runtime-that-does-not-exist-)).
That gap closes with the job runtime, not with this module.

---

## 9. Estimated shape

| File                                       | Tests | Covers                                      |
| ------------------------------------------ | ----- | ------------------------------------------- |
| `tests/unit/files/file-policy.test.ts`     | ~14   | §5 read policy, per-purpose validation      |
| `tests/unit/files/magic-bytes.test.ts`     | ~12   | 02 §5 table, table-driven                   |
| `tests/unit/files/storage-key.test.ts`     | ~8    | 03 §5 grammar, unguessability               |
| `tests/unit/files/file-service-tx.test.ts` | ~10   | unit-of-work, ordering (R-FILE-25/26)       |
| `tests/integration/file-upload.test.ts`    | ~20   | §3 #1/#2/#7/#8, 04 §2                       |
| `tests/integration/file-read.test.ts`      | ~18   | §3 #4/#5/#6, §5                             |
| `tests/integration/file-lifecycle.test.ts` | ~14   | §3 #9, retention, sweeper                   |
| `tests/integration/file-supersede.test.ts` | ~12   | FILE-INV-8, R-FILE-31/32, the 03 §4A.2 race |
| `tests/integration/file-security.test.ts`  | ~16   | §5                                          |
| `tests/integration/file-schema.test.ts`    | ~10   | §7                                          |

**~134 tests**, taking the suite from 364 to roughly 498. Proportionate to AUTH (which needed more,
being larger) and to USER (which needed ~110 for a comparable surface).

---

## 9A. Security review checklist

For the recurring security review. **Every line names what proves it** — a checklist of ticks with
nothing behind them is how a control gets marked present the year after it was removed.

| ✓   | Control                                             | Enforced by                             | Proven by                                                            |
| --- | --------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| ☐   | Private bucket, no public ACL                       | 08 §2.3 (all four public-access blocks) | Bucket config, not code — verify in the console before `provider=s3` |
| ☐   | Signed URLs are the only read path                  | R-FILE-11                               | §5 "private by default"                                              |
| ☐   | Read TTL in minutes, < token life                   | R-FILE-16, 02 §5                        | §5 URL TTL                                                           |
| ☐   | Upload URL is single-key, single-method, size-bound | R-FILE-2                                | §5 URL scope                                                         |
| ☐   | Declared MIME validated                             | R-FILE-4, 02 §5                         | §5 magic bytes (table-driven)                                        |
| ☐   | **Actual bytes** validated                          | R-FILE-5                                | §3 #2                                                                |
| ☐   | Size ceiling per purpose                            | R-FILE-3, 02 §5                         | §3 #2                                                                |
| ☐   | Filename sanitized, key unaffected                  | R-FILE-28, 02 §5.1                      | §5 path traversal                                                    |
| ☐   | Storage key unguessable                             | R-FILE-7, 03 §5                         | §5 key unguessability (1,000 keys)                                   |
| ☐   | EXIF/GPS stripped                                   | R-FILE-29, FILES-OD-10                  | new case in `file-upload`                                            |
| ☐   | No URL/key in response, event, or log               | FILE-INV-2                              | §3 #3, §4                                                            |
| ☐   | Existence not disclosed on denial                   | FILE-INV-4                              | §4, §5                                                               |
| ☐   | Privileged reads audited                            | R-FILE-15                               | §3 #5, §6                                                            |
| ☐   | Audit is on the critical path                       | 05 §3.2                                 | §5 audit-on-critical-path                                            |
| ☐   | Fail-closed on provider outage                      | 04 §6                                   | §5 fail-closed                                                       |
| ☐   | Rate limits + byte quotas                           | R-FILE-9/30                             | §5 rate-limit axes                                                   |
| ☐   | Soft delete, never inline erase                     | R-FILE-18                               | §3 #9                                                                |
| ☐   | Erase removes **every version**                     | R-FILE-23, 07 §2, 08 §2.2               | §5 erase-clears-versions                                             |
| ☐   | Encryption at rest                                  | 08 §2 (`AES256` default, fail-closed)   | Bucket config                                                        |
| ☐   | Checksums recorded                                  | R-FILE-10                               | §3 #2                                                                |
| ☐   | Least-privilege IAM                                 | 08 §2.3 bucket policy                   | Infrastructure review                                                |

Four rows are **not code** and cannot be proven by this suite: bucket privacy, lifecycle, encryption
default, and IAM. They are verified against the live bucket before `provider=s3` is switched on, and
saying so is the point — a checklist that implies tests cover them would be worse than no checklist.

---

## 10. Exit criteria

FILES is done when:

1. Every row of §3 is green.
2. Every invariant in §4 is proven, the two concurrent ones with `Promise.all`.
3. The whole suite passes against **both** provider implementations (criterion #10).
4. `npm run typecheck`, `npm run lint --max-warnings=0`, `npx prettier --check`, `npx prisma validate` all clean.
5. The two limits in §8 are the only uncovered claims, and both are written down here.
