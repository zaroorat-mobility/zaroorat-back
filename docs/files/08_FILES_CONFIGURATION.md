# FILES — Configuration

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 08 of the FILES chain
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _Every knob this module has, its default, and what happens when it is unset._
> **Traces from:** [01_BUSINESS](01_FILES_BUSINESS_REQUIREMENTS.md) R-FILE-3/20/30 · [02_API](02_FILES_API_SPEC.md) §5–§6 · [07_PROVIDER](07_FILES_STORAGE_PROVIDER.md)
> **Traces to:** 09_OPERATIONS

---

## 1. Shape

Two frozen objects, following `userConfig` and `notificationConfig` exactly: plain values, read from
the environment at module load, no getters, no reload-at-runtime. Feature-flagged config is
`settings`' job (FR-CONFIG), and that module does not exist.

```
src/config/file/file.config.ts       → policy: purposes, limits, quotas, retention
src/modules/files/storage.config.ts  → infrastructure: provider, bucket, region, credentials
```

The split is not cosmetic. Policy is reviewed by product and compliance; infrastructure is reviewed
by whoever holds the cloud account. `notifications` splits the same way.

---

## 2. Storage configuration

| Key                               | Env                                                   | Default                            | Notes                                                 |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `provider`                        | `STORAGE_PROVIDER`                                    | `mock` dev/test, `s3` staging/prod | Same defaulting rule as `SMS_PROVIDER`                |
| `bucket`                          | `STORAGE_BUCKET`                                      | — (**required** for `s3`)          | The **only** bucket. There is no public bucket (§2.1) |
| `region`                          | `STORAGE_REGION`                                      | `ap-south-1`                       | Mumbai — data residency for an Indian market          |
| `endpoint`                        | `STORAGE_ENDPOINT`                                    | null                               | Set for MinIO / R2 / Spaces (07 §5)                   |
| `forcePathStyle`                  | `STORAGE_FORCE_PATH_STYLE`                            | `false`                            | `true` for MinIO                                      |
| `accessKeyId` / `secretAccessKey` | `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | —                                  | Absent ⇒ fall back to the instance role. Never logged |
| `serverSideEncryption`            | `STORAGE_SSE`                                         | `AES256`                           | Security 03 §42. `aws:kms` supported                  |
| `kmsKeyId`                        | `STORAGE_KMS_KEY_ID`                                  | null                               | Required only when `SSE=aws:kms`                      |
| `uploadUrlTtlSeconds`             | `STORAGE_UPLOAD_TTL_SEC`                              | `900` (15 min)                     | The write permission window                           |
| `peekBytes`                       | `STORAGE_PEEK_BYTES`                                  | `512`                              | Enough for every signature in 02 §5                   |
| `requestTimeoutMs`                | `STORAGE_TIMEOUT_MS`                                  | `5000`                             | Beyond this → `503`, never a hung request             |
| `maxRetries`                      | `STORAGE_MAX_RETRIES`                                 | `2`                                | Provider-level, retryable errors only (07 §4)         |

### 2.1 There is exactly one bucket, and it is private

A "public bucket" is a category this module does not have. Every purpose in 02 §5 is either personal
data or compliance evidence, and R-FILE-11 makes the private bucket an invariant rather than a
default. Adding a public bucket later would need a new purpose, a new read policy, and a change to
R-FILE-11 — which is the correct amount of friction for that decision.

**Consequently there is no CDN.** A CDN in front of per-request signed URLs caches either nothing
(pointless) or something it should not (dangerous). If public assets ever exist — marketing images,
app icons — they belong to a different system, not to a module whose entire contract is "nothing is
readable without a signature."

### 2.2 Bucket versioning, and the trap in it

**Versioning is ON.** Not this module's choice —
[11_Infrastructure/06](../11_Infrastructure/06_backups-and-dr.md) makes it platform policy
("versioned, encrypted bucket + cross-location replication"), and it is what makes object-storage
loss recoverable at all.

It also creates a trap that is easy to ship and hard to notice:

> On a versioned bucket, `DeleteObject` **does not delete anything**. It writes a delete marker.
> Every previous version stays retrievable, indefinitely, by anyone who can name a version id.

So a retention job that "erases" a file by calling delete would leave the bytes fully recoverable
while `file.erased` announced, durably and in the audit trail, that they were gone. **An erasure
request under a privacy obligation would be recorded as honoured and not be.** That is the failure
this section exists to prevent, and it is why 07 §2 has two methods rather than one:

| Caller    | Method      | On a versioned bucket                                 | Why it is right                                           |
| --------- | ----------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Sweeper   | `delete()`  | Delete marker; earlier versions survive               | The orphan was never verified and never referenced        |
| Retention | `erase()`   | **Every version id removed**, delete markers included | This is the one place "gone" has to mean gone (R-FILE-23) |
| Retention | `archive()` | Storage class change; all versions preserved          | Archive is the opposite of erasure (R-FILE-21)            |

### 2.3 Required bucket configuration

Not application config — bucket state that must exist before `provider=s3` is switched on. Owned by
whoever holds the cloud account; listed here because the module's guarantees depend on it.

| Setting                         | Required value                                  | Why                                                                              |
| ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Versioning                      | **Enabled**                                     | Platform DR policy                                                               |
| Public access block             | **All four blocks on**                          | R-FILE-11. A private bucket that is one console click from public is not private |
| Bucket policy                   | Deny any request without the app's principal    | Signed URLs are the only read path                                               |
| Default encryption              | `AES256`, or `aws:kms` with a stable key id     | Security 03 §42                                                                  |
| Lifecycle: non-current versions | Expire after **30 days**                        | Bounds the cost of versioning; DR's recovery window is far shorter               |
| Lifecycle: incomplete multipart | Abort after **1 day**                           | v1 does not use multipart, so any such upload is debris                          |
| CORS                            | `PUT` from app origins only, on the upload path | The browser client PUTs directly (R-FILE-1) and cannot without it                |

The 30-day non-current expiry and `erase()` do different jobs and both are needed: the lifecycle rule
bounds _cost_ for ordinary churn, `erase()` provides _immediacy_ for a compliance obligation that
cannot wait 30 days.

### 2.4 Multipart upload

**Not implemented** (01 §2.3). The threshold that would trigger it (~100 MB) is above every ceiling
in §3; the largest purpose is 50 MB. `STORAGE_MULTIPART_THRESHOLD` is deliberately absent rather
than present-and-unused — a knob that does nothing is a knob someone will turn.

---

## 3. Purpose policy — configured, not restated

**The values live in [02 §5](02_FILES_API_SPEC.md#5-per-purpose-policy--the-authoritative-table).**
This section covers only how they are shaped in code and what may be overridden — deliberately not a
second copy.

They were duplicated until a review asked for "a single authoritative table" and the answer turned
out to be that there were two. The read-TTL bug in §3.0 existed in **both** copies, which is what a
duplicated table buys: not a disagreement, a defect that has to be found and fixed twice.

```ts
// src/config/file/file.config.ts — one frozen record, keyed by purpose.
export const filePurposePolicy = Object.freeze({
  PROFILE_IMAGE: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
    maxPixels: { width: 4096, height: 4096 },
    readTtlSeconds: 600,
    stripExif: true,
    retention: { afterDays: 365, trigger: 'REPLACED', action: 'ERASE' },
  },
  // … one entry per purpose, exactly matching 02 §5
} as const);
```

| Field            | Env-overridable? | Why                                                                                                  |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `mimeTypes`      | ❌               | Security control — §8.2                                                                              |
| `maxPixels`      | ❌               | Security control (R-FILE-35); a raised ceiling is a decompression budget                             |
| `stripExif`      | ❌               | Privacy control (R-FILE-29)                                                                          |
| `retention`      | ❌               | Compliance; changing it needs the review in §3.1, not a deploy                                       |
| `maxBytes`       | ✅ per purpose   | The one value with a legitimate operational reason to differ — a staging bucket with a smaller quota |
| `readTtlSeconds` | ✅ globally down | May be tightened, never past the R-FILE-36 assertion (§8.1)                                          |

**Two of six are overridable, and both only in the safe direction.** A knob that can loosen a
security control is not configuration, it is a bypass with a `.env` file for a key.

### 3.0 The read TTLs changed, because the old ones broke R-FILE-16

R-FILE-16 requires every read TTL to be **shorter than the access token that authorized it**. The
codebase sets `jwtConfig.accessTtlSeconds = 900` — **15 minutes**
(`src/config/jwt/jwt.config.ts:12`).

The previous table gave `PROFILE_IMAGE` and `VEHICLE_IMAGE` a 15-minute read TTL. **Equal is not
shorter.** A URL minted in the first second of a token's life outlived that token, which is precisely
the window R-FILE-16 exists to close.

Corrected, and now graded by sensitivity rather than set flat:

| Sensitivity               | TTL     | Purposes                              |
| ------------------------- | ------- | ------------------------------------- |
| Personal, low consequence | 10 min  | `PROFILE_IMAGE`, `VEHICLE_IMAGE`      |
| Identity documents        | 5 min   | `DRIVER_DOCUMENT`, `VEHICLE_DOCUMENT` |
| Incident evidence         | 2–3 min | `SOS_EVIDENCE`, `DISPUTE_EVIDENCE`    |

**This must not be maintained by hand.** R-FILE-36: startup asserts
`max(readTtl) < jwtConfig.accessTtlSeconds` and refuses to boot otherwise. The constraint was
violated the moment it was written down as prose in one document and a number in another; a
cross-config assertion is the only version that survives someone tuning `JWT_ACCESS_TTL_SECONDS`
down without ever opening this file.

### 3.1 Where the retention numbers come from — and what they are not

**These are engineering defaults, not legal advice, and they are the one part of this chain that
must be reviewed by someone qualified before production.** They are recorded here so the system has
a defined behaviour instead of an undefined one, and so the review has something concrete to correct.

| Value                         | Reasoning                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KYC **8 years**               | India's Companies Act keeps books of account 8 years; KYC substantiates the contractor relationship those books record. Longer than any single dispute window, and the longest defensible default.            |
| SOS **10 years**              | A safety incident can become a criminal matter with a long limitation period. R-SAFE-4 says "sufficient for incident investigation"; under-retaining here is unrecoverable, over-retaining is a storage bill. |
| Dispute **5 y after closure** | The Limitation Act's general 3-year period plus headroom for an appeal.                                                                                                                                       |
| Profile **365 d**             | Not compliance — just long enough that "undo my avatar change" is answerable.                                                                                                                                 |
| Vehicle image **90 d**        | Nothing depends on it once a vehicle is retired.                                                                                                                                                              |

**Archive ≠ erase.** Every KYC/safety/dispute row archives (R-FILE-21). `erased_at` stays null
because the bytes still exist, and `file.erased` carries `action: "ARCHIVED"` (05 §3.4).

**Retention clocks do not start at upload** for anything except `PROFILE_IMAGE`. A driver document's
8 years starts when the driver relationship ends, not when the licence was uploaded — otherwise an
active driver's documents would be archived out from under them. The trigger column in 03 §6 is
therefore load-bearing, not decorative.

---

## 4. Rate limits

Restates [02 §6](02_FILES_API_SPEC.md#6-rate-limits-r-file-9) with its env keys.

| Key                        | Env                                 | Default |
| -------------------------- | ----------------------------------- | ------- |
| `uploadsPerUserPerHour`    | `FILE_UPLOADS_PER_HOUR`             | `30`    |
| `uploadsPerPurposePerHour` | `FILE_UPLOADS_PER_PURPOSE_PER_HOUR` | `10`    |
| `readUrlsPerUserPerMinute` | `FILE_READ_URLS_PER_MINUTE`         | `60`    |

Redis-keyed, same limiter primitives as AUTH's OTP axes; strictest axis wins.

---

## 5. Quotas — R-FILE-30

Rate limits bound **requests**; quotas bound **bytes**. Thirty 50 MB clips an hour satisfies §4 and
is 1.5 GB (FILES-OD-11).

| Key                       | Env                        | Default | Enforced at   |
| ------------------------- | -------------------------- | ------- | ------------- |
| `maxTotalBytesPerUser`    | `FILE_QUOTA_USER_BYTES`    | 500 MB  | `POST /files` |
| `maxTotalBytesPerPurpose` | `FILE_QUOTA_PURPOSE_BYTES` | 200 MB  | `POST /files` |
| `maxDailyBytesPerUser`    | `FILE_QUOTA_DAILY_BYTES`   | 200 MB  | `POST /files` |

- Counted over `READY` and `PENDING` rows, **excluding** soft-deleted ones — the bytes still exist
  until retention, but charging a user for storage they asked to delete is indefensible.
- Checked **before** signing, so an over-quota upload never creates an object.
- Exceeded → `429 RATE_LIMITED` with `details[].limit`, reusing the existing code rather than
  minting a quota-specific one (04 §2.1).

**Not per-role.** A driver legitimately stores more than a rider, and the per-purpose cap already
expresses that: only a driver uploads `DRIVER_DOCUMENT`. A second dimension keyed on role would
encode the same fact twice and drift.

---

## 6. Job schedules

Consumed by 09 §4. Present here so every tunable lives in one document; **inert until a job runtime
exists** (01 §13.4).

| Key                  | Env                     | Default        |
| -------------------- | ----------------------- | -------------- |
| `sweeperCron`        | `FILE_SWEEPER_CRON`     | `*/15 * * * *` |
| `sweeperBatchSize`   | `FILE_SWEEPER_BATCH`    | `500`          |
| `retentionCron`      | `FILE_RETENTION_CRON`   | `0 3 * * *`    |
| `retentionBatchSize` | `FILE_RETENTION_BATCH`  | `200`          |
| `jobMaxAttempts`     | `FILE_JOB_MAX_ATTEMPTS` | `5`            |

---

## 7. Fail-closed defaults

The rule USER's `profileImageHosts` established: **an unset security-relevant value denies, never
permits.**

| Unset / missing                      | Behaviour                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `STORAGE_BUCKET` with `provider=s3`  | **Boot fails.** Not a runtime `503` — a misconfigured deploy should never accept traffic. |
| Credentials **and** no instance role | Boot fails, same reasoning.                                                               |
| A purpose absent from §3             | Every upload for it is rejected. There is no default policy.                              |
| An empty MIME allow-list             | Rejects everything for that purpose.                                                      |
| A quota of `0`                       | Rejects everything. `0` is a real limit, not "unlimited".                                 |
| `STORAGE_SSE` unset                  | Falls back to `AES256`, never to none.                                                    |

The one deliberate difference from USER: FILES fails at **boot**, not per-request. USER could not —
a missing host list is a policy gap, and the module still has other work to do. A `files` module
without a bucket has no work at all, and failing fast turns a subtle production outage into an
obvious deploy failure.

---

## 8. Config validation at startup

Parsed and validated by Zod at module load, in the shape `notificationConfig` uses.

```ts
// Illustrative — the real schema lives in src/config/file/file.config.ts
const storageSchema = z
  .object({
    provider: z.enum(['mock', 's3']),
    bucket: z.string().min(1).optional(),
    region: z.string().default('ap-south-1'),
    // …
  })
  .refine((c) => c.provider !== 's3' || !!c.bucket, {
    message: 'STORAGE_BUCKET is required when STORAGE_PROVIDER=s3',
  });
```

Every numeric env var is bounded — a `readUrlTtlSeconds` of `86400` would silently defeat R-FILE-16,
so the ceiling is enforced where it is parsed rather than trusted at the call site.

### 8.1 The cross-config assertion (R-FILE-36)

Bounding each value alone is not enough: the constraint is **relative to another module's config**.

```ts
// Runs at module load, beside the schema parse. Boot fails, not a request.
const longestRead = Math.max(...Object.values(fileConfig.purposes).map((p) => p.readTtlSeconds));
if (longestRead >= jwtConfig.accessTtlSeconds) {
  throw new Error(
    `FILES read TTL (${longestRead}s) must be shorter than the access token (${jwtConfig.accessTtlSeconds}s) — R-FILE-16`,
  );
}
```

It fails at **boot**, per §7's rule: a misconfigured deploy should never accept traffic. And it fails
for whoever lowers `JWT_ACCESS_TTL_SECONDS` in a completely different module — which is the person
who would otherwise never learn they had broken this.

### 8.2 Why per-purpose policy is not environment variables

A reasonable suggestion is `FILES_ALLOWED_PROFILE_IMAGE_MIME`, `FILES_MAX_DRIVER_DOCUMENT_SIZE`, and
so on. **Declined**, for three reasons:

1. **A MIME allow-list is a security control.** As an env var it becomes runtime-mutable by anyone
   with deploy access, with no code review, no diff, and no test run. §7 already treats an empty
   allow-list as "reject everything" precisely because this list is load-bearing.
2. **It does not vary by environment.** `staging` and `production` accept the same document formats;
   that is what makes staging a rehearsal. A knob that must hold the same value everywhere is not
   configuration, it is a constant with extra failure modes.
3. **Twelve-plus variables per purpose × six purposes** is a surface where a typo yields a silently
   permissive policy — `image/jpg` instead of `image/jpeg` quietly rejects every JPEG, and nothing
   fails until a user complains.

The split in §1 stands: **policy in `file.config.ts`** (reviewed, typed, tested), **infrastructure in
env** (bucket, region, credentials, provider — the things that genuinely differ per environment).
`userConfig` draws the same line, and `notificationConfig` before it.

---

## 9. Traceability

| Section | Realizes                         | Proven by (06)        |
| ------- | -------------------------------- | --------------------- |
| §2      | 07 §5, Security 03 §42           | §3 #10                |
| §3      | R-FILE-3, R-FILE-20, FILES-OD-10 | §3 #2, §5 magic bytes |
| §4      | R-FILE-9                         | §5 rate-limit axes    |
| §5      | R-FILE-30, FILES-OD-11           | §5 (new quota cases)  |
| §7      | NFR-7 fail-closed                | §5 fail-closed        |
| §8      | R-FILE-16                        | §5 URL TTL            |
