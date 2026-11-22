# FILES — API Specification

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 02 of the FILES chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _Exactly what is on the wire, and exactly which guard runs before each handler?_
> **Traces from:** [01_BUSINESS](01_FILES_BUSINESS_REQUIREMENTS.md) §4–§7 · [07_API/01](../07_API/01_rest-conventions.md) · [AUTH 04](../auth/04%20auth%20api%20spec.md) §3 (the gate)
> **Traces to:** 04_ERRORS · 06_TEST_PLAN §3

---

## 1. Surface

Five endpoints, all under `/api/v1/files`, all authenticated. There is no public route in this
module — a private bucket with a public API in front of it would be a private bucket with extra
steps.

| Method   | Path                   | Purpose                                 | Idempotent |
| -------- | ---------------------- | --------------------------------------- | ---------- |
| `POST`   | `/files`               | Request permission to upload one object | ⏱ required |
| `POST`   | `/files/{id}/complete` | Confirm the bytes; verify and publish   | ⏱ natural  |
| `GET`    | `/files/{id}/url`      | Mint a short-lived signed read URL      | safe       |
| `GET`    | `/files/{id}`          | File metadata, without a URL            | safe       |
| `DELETE` | `/files/{id}`          | Soft-delete                             | natural    |

`⏱ required` = the request is rejected without an `Idempotency-Key`. `⏱ natural` = repeating it
converges without a key (§2.2).

---

## 2. Endpoints

### 2.1 `POST /files` — request an upload permission

Validates intent, reserves a row, and returns a permission scoped to exactly one object.

**Request**

```jsonc
{
  "purpose": "DRIVER_DOCUMENT", // required — drives every policy (R-FILE-3)
  "fileName": "licence-front.jpg", // required — for display and extension only; never the key
  "contentType": "image/jpeg", // required — must be permitted for the purpose
  "sizeBytes": 842114, // required — declared; verified at completion
  "checksumSha256": "9f86d0…", // optional — if given, enforced at completion
}
```

Headers: `Authorization: Bearer …`, `Idempotency-Key: <uuid>` (**required** — without it a retried
request orphans an object in storage, R-FILE-8).

**Key retention: 24 hours**, matching `IDEMPOTENCY_TTL_SECONDS` in `auth.service.ts` and
`phone-change.service.ts`. The value is a module constant, not config, for the same reason it is
there: it is a protocol property clients depend on, not an operational tunable. A replay after 24 h
is a fresh upload — safe, because the previous permission expired in 15 minutes anyway.

**Response — `201 Created`**

```jsonc
{
  "fileId": "0198f2c1-…",
  "status": "PENDING",
  "upload": {
    "method": "PUT",
    "url": "https://s3.…/zaroorat-private/dd/0198…?X-Amz-Signature=…",
    "headers": { "Content-Type": "image/jpeg" }, // client MUST send exactly these
    "expiresAt": "2026-08-02T10:20:00Z", // minutes, not hours
  },
}
```

- The `url` is **write-only, single-key, single-method, content-type-bound, size-bound**. It cannot
  read, cannot list, and cannot touch any other key (R-FILE-2).
- `upload.url` is the one place in the whole API where a signed URL appears in a response body. It
  is never logged and never stored (FILE-INV-2). Read URLs live at §2.3 and are equally transient.
- The client PUTs the bytes **directly to storage**. The API sees none of them (R-FILE-1).

**Refusals** — `UNSUPPORTED_MEDIA_TYPE` (415), `FILE_TOO_LARGE` (413), `RATE_LIMITED` (429), and
`VALIDATION` (400) — which covers a **missing `Idempotency-Key`** too, following USER's precedent
(`user.controller.ts` returns `VALIDATION` for exactly this) rather than minting a dedicated code.
Full catalog in [04](04_FILES_ERROR_CATALOG.md).

---

### 2.2 `POST /files/{id}/complete` — verify and publish

The client calls this after its PUT succeeds. **This is where the file becomes real.**

**Request** — empty body.

**What the server does, in order:**

1. Load the file; require `PENDING` and caller ownership.
2. `HEAD` the object. Absent → `UPLOAD_NOT_FOUND` (409); the row stays `PENDING` and is retriable.
3. Compare **actual** size against the ceiling and against the declared value (R-FILE-5).
4. Read the object's leading bytes and match the **magic number** against the declared content-type.
   A PNG renamed `.jpg`, or an ELF renamed `.pdf`, dies here.
5. For images, read **pixel dimensions from the header** and check them against the purpose ceiling
   — before any decode (R-FILE-35, §5.2).
6. Compare the checksum, if one was declared.
7. Refuse the image if it carries **EXIF location data** and the purpose does not preserve it
   (R-FILE-29, FILES-OD-16). Read from the same header slice as steps 4–5; nothing is decoded and
   nothing is rewritten.
8. On any failure: **delete the object**, mark the row `EXPIRED`, and return the specific error.
9. On success: `PENDING → READY` and emit `file.uploaded` **in one transaction** (R-FILE-24).

Steps 3–7 are ordered cheapest-first and each is a hard gate: bytes, then declared type, then pixel
count, then metadata. Every one of them reads the header slice `head()` already returned, so the
whole of completion is one round trip to storage.

**Response — `200 OK`**

```jsonc
{
  "fileId": "0198f2c1-…",
  "status": "READY",
  "purpose": "DRIVER_DOCUMENT",
  "contentType": "image/jpeg",
  "sizeBytes": 842114,
  "checksumSha256": "9f86d0…",
  "createdAt": "2026-08-02T10:15:22Z",
}
```

**Idempotency without a key.** Completing an already-`READY` file returns the same `200` body and
emits **no second event** — the state guard is a conditional update (`WHERE status = 'PENDING'`),
so of two concurrent completions exactly one transitions and one observes the result (FILE-INV-6).
This is the same `updateMany`-returns-count pattern AUTH uses for OTP outcomes.

---

### 2.3 `GET /files/{id}/url` — mint a signed read URL

**Query:** `?disposition=inline|attachment` (optional, default `inline`).

**Response — `200 OK`**

```jsonc
{
  "url": "https://s3.…/zaroorat-private/dd/0198…?X-Amz-Signature=…",
  "expiresAt": "2026-08-02T10:20:00Z",
  "contentType": "image/jpeg",
}
```

- TTL is per-purpose config, in **minutes**, and always shorter than the access-token lifetime
  (R-FILE-16).
- Every call mints a **new** URL. Nothing is cached; there is no stable URL for any file, ever.
- A caller who may not read this file gets **`404 NOT_FOUND`** — byte-identical to a nonexistent id
  (R-FILE-14, FILE-INV-4). Never `403`, which would confirm existence.
- If the caller is **not the owner**, the mint writes an audit record before returning
  (R-FILE-15) — see [05 §3.2](05_FILES_EVENT_CATALOG.md#32-fileread--the-privileged-access-audit).

---

### 2.4 `GET /files/{id}` — metadata only

Same visibility rules as §2.3, but mints nothing and audits nothing (metadata is not the sensitive
payload). Returns the §2.2 body shape. Useful for a client rendering a review queue that only needs
names and sizes.

---

### 2.5 `DELETE /files/{id}` — soft-delete

**Response — `204 No Content`.**

- Sets `deleted_at`; the row leaves every read path immediately.
- The **object is not touched.** Erasure is the retention job's (R-FILE-18).
- If a live domain row still references the file → **`409 FILE_IN_USE`**, naming the owning module
  in `details` and nothing else (R-FILE-19, FILE-INV-5).
- Repeating a delete on an already-deleted file returns `204`.

---

## 3. Guard wiring

The platform gate is **deny-by-default** (AUTH 04 §3): a global `onRequest` hook authenticates every
route unless it opts out with `config: { public: true }`. **No route in this module opts out.**

```ts
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const controller = app.diContainer.resolve<FileController>('fileController');

  // Every route here is authenticated by the global gate. Nothing is public:
  // a private bucket behind a public API is not a private bucket.
  app.post('/', controller.createUpload);
  app.post('/:id/complete', controller.completeUpload);
  app.get('/:id', controller.getMetadata);
  app.get('/:id/url', controller.getReadUrl);
  app.delete('/:id', controller.remove);
}
```

**No `requireUntamperedDevice`.** Uploading a document from a rooted phone is not the threat that
guard addresses — it exists for actions that move an identity (phone change). Adding it here would
lock out a legitimate driver with a modded handset from onboarding at all.

**No role guard.** Authorization here is **relational**, not role-based: it depends on the caller's
relationship to _this_ file, which a route-level role check cannot see. It lives in the service, at
§4.

---

## 4. The read policy

One function, consulted by §2.3 and §2.4. It is the whole of `files`' authorization.

| Purpose            | Owner | Ops with scope                | Anyone else |
| ------------------ | ----- | ----------------------------- | ----------- |
| `PROFILE_IMAGE`    | ✅    | ✅ `users:read` (audited)     | ❌          |
| `DRIVER_DOCUMENT`  | ✅    | ✅ `drivers:verify` (audited) | ❌          |
| `VEHICLE_DOCUMENT` | ✅    | ✅ `drivers:verify` (audited) | ❌          |
| `VEHICLE_IMAGE`    | ✅    | ✅ `drivers:verify` (audited) | ❌          |
| `SOS_EVIDENCE`     | ✅    | ✅ `safety:read` (audited)    | ❌          |
| `DISPUTE_EVIDENCE` | ✅    | ✅ `support:read` (audited)   | ❌          |

- **Owner** = `files.owner_user_id == request.auth.userId`.
- Only a `READY` file is readable. `SUPERSEDED` and `DELETED` are invisible to everyone, including
  their owner and ops — a previous licence version is retained as evidence (R-FILE-32), not served.
  Reading history is an `admin` capability that does not exist yet, and when it does it arrives with
  its own audit path.
- **Ops scope** comes from `request.auth.roles`. The scopes above are named here for the policy's
  sake; `admin` owns granting them, and until that module exists **only the owner branch is
  reachable** — the ops branch is specified, tested against a hand-granted role, and dormant.
- Every ✅ in the ops column is an **audited** read (R-FILE-15).
- A rider must never read a driver's licence, and a driver must never read a rider's photo. There is
  no "both are on the same trip" exception in v1.

---

## 5. Per-purpose policy — the authoritative table

**This is the single source for every per-purpose rule.** Nothing else in the chain restates these
values; 08 §3 covers only _how_ they are configured and overridden. One table, one home — the
previous split across two documents meant a change had to land in both, and it already didn't once
(the read TTLs violated R-FILE-16 in both copies simultaneously).

Backed by `file.config.ts` — configuration, never code (R-FILE-3, R-FILE-20).

| Purpose            | MIME allow-list                                            | Max size | Max pixels    | Read TTL | GPS refused   | Retention               | Terminal action |
| ------------------ | ---------------------------------------------------------- | -------- | ------------- | -------- | ------------- | ----------------------- | --------------- |
| `PROFILE_IMAGE`    | `image/jpeg`, `image/png`, `image/webp`                    | 5 MB     | 4096 × 4096   | 10 min   | ✅            | 365 d after replacement | erase           |
| `DRIVER_DOCUMENT`  | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` | 10 MB    | 5000 × 5000   | 5 min    | ✅            | **8 years**             | archive         |
| `VEHICLE_DOCUMENT` | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` | 10 MB    | 5000 × 5000   | 5 min    | ✅            | **8 years**             | archive         |
| `VEHICLE_IMAGE`    | `image/jpeg`, `image/png`, `image/webp`                    | 5 MB     | 6000 × 6000   | 10 min   | ✅            | 90 d after retirement   | erase           |
| `SOS_EVIDENCE`     | `image/jpeg`, `image/png`, `image/webp`, `video/mp4`       | 50 MB    | 8000 × 8000 ¹ | 2 min    | ❌ (evidence) | **10 years**            | archive         |
| `DISPUTE_EVIDENCE` | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` | 10 MB    | 8000 × 8000   | 3 min    | ❌ (evidence) | 5 y after closure       | archive         |

¹ Images only. Video dimensions are not checked in v1 — nothing decodes an MP4 (§5.2).

**Upload URL TTL is not a column** because it is not per-purpose: it is a single global 15 minutes
(`STORAGE_UPLOAD_TTL_SEC`, 08 §2). A column identical in every row invites someone to vary it, and
nothing about the purpose changes how long a client needs to PUT.

Retention reasoning — where 8 years and 10 years come from, and why archive is not erase — is in
[08 §3.1](08_FILES_CONFIGURATION.md#31-where-the-retention-numbers-come-from--and-what-they-are-not).

There is no `*/*`, no `application/octet-stream`, and no purpose without an allow-list. A MIME type
absent from every list cannot be uploaded at all.

**`image/webp` is on every image list.** Current Android screenshots and share sheets produce WebP by
default; omitting it means a user photographing their own licence, or screenshotting a dispute, is
refused for a reason they cannot act on.

### 5.0 Extensions are an output, not an input

There is deliberately **no "allowed extensions" column**, because an extension is never validated —
it is _derived_, from the content-type that magic bytes proved (§5.1, 03 §5).

| Verified content-type | Extension |
| --------------------- | --------- |
| `image/jpeg`          | `.jpg`    |
| `image/png`           | `.png`    |
| `image/webp`          | `.webp`   |
| `application/pdf`     | `.pdf`    |
| `video/mp4`           | `.mp4`    |

The client's `licence.PDF.exe` contributes nothing: the stored key ends `.pdf` if and only if the
bytes began `25 50 44 46`. Listing "allowed extensions" as policy would imply a check against the
client's string, and that check is exactly the one an attacker chooses their filename to pass.

This mapping is one-way and total — every allowed content-type has exactly one extension, and no
extension is accepted that does not appear here.

### 5.2 Pixel ceilings, and why nothing is decoded (R-FILE-35)

The size ceiling bounds **bytes on the wire**. It does not bound what those bytes become.

A 5 MB PNG can legally decode to 40,000 × 40,000 pixels — **6.4 GB** of RGBA in memory. A few of
those in parallel take the process down, and the request that does it looks, at every layer that
checks size, entirely legitimate.

An earlier draft of this section said the ceiling mattered "because R-FILE-29 makes us decode".
It does not: FILES-OD-16 settled the metadata rule as a **refusal**, and refusing is a container
walk, not a decode. So v1 never enters a decoder at all, and the ceiling guards the day something
does — a thumbnailer, an OCR pass, an ops preview — rather than a hazard already present.

At completion, all from the header slice `head()` already returned:

1. Read dimensions from the **header only** — every allowed format declares them in its first bytes.
   No pixels are read to learn this.
2. **Normalize by the EXIF orientation tag first**, so a 6000 × 4000 portrait photograph is not
   measured as 4000 × 6000. A phone held sideways writes a transposed frame and an orientation of 6;
   measuring the stored frame refuses the picture for a shape it does not have.
3. Reject `width × height` above the purpose's ceiling → `413 FILE_TOO_LARGE` with
   `details[].limit`.
4. Reject an image carrying EXIF location data, where the purpose does not preserve it (§5.3).

PDFs are not decoded and have no pixel ceiling — `application/pdf` is stored as delivered, never
parsed. A PDF is a program, and rendering one to inspect it would be a far larger surface than the
inspection is worth.

### 5.3 Location metadata is refused, not stripped (R-FILE-29, FILES-OD-16)

EXIF GPS lives in a **container-level segment** — a JPEG `APP1`, a PNG `eXIf` chunk, a WebP `EXIF`
chunk — beside the pixel data rather than inside it. Finding it is a walk over bytes already
fetched.

| Verdict   | Meaning                                             | Purpose strips → | Purpose keeps → |
| --------- | --------------------------------------------------- | ---------------- | --------------- |
| `ABSENT`  | The walk reached the pixel data without finding GPS | accept           | accept          |
| `PRESENT` | An IFD0 GPS pointer is there                        | **`422`**        | accept          |
| `UNKNOWN` | The metadata region ran past the peek               | **`422`**        | accept          |

`UNKNOWN` is refused because a privacy control that fails open is not a control: _"I looked and
found nothing"_ and _"I ran out of bytes"_ are different answers. In practice it is rare — a JPEG's
`APP1` is capped at 64 KB by the format and `STORAGE_IMAGE_PEEK_BYTES` is 128 KB.

Only the **presence of the GPS directory pointer in IFD0** is checked. The pointer is not followed:
its presence is the whole question, and not following it means no second bounds check and no chance
of a crafted offset sending the reader somewhere else.

An image with EXIF but no GPS is **accepted**. A camera writes make, model, exposure, and
orientation on every frame; refusing those would refuse nearly every photograph, and none of them
says where anyone lives.

### 5.1 Filename policy (R-FILE-28)

`fileName` is **attacker-controlled text**. It never reaches the storage key (03 §5), so traversal
cannot escape a prefix — but it is stored, returned to other readers, and rendered in an ops console,
so it is sanitized on the way in.

| Rule               | Value                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Max length         | 255 bytes **UTF-8** (not characters — the DB and every filesystem count bytes)                                                  |
| Min length         | 1 after sanitization; an empty result becomes `file{ext}`                                                                       |
| Unicode            | Allowed, **NFC-normalized**. Rejecting non-ASCII would reject Urdu and Hindi filenames on a platform whose users write in both. |
| Emoji              | Allowed. They are ordinary code points, and banning them is theatre.                                                            |
| Stripped entirely  | C0/C1 controls, `U+0000`, RTL/LTR overrides (`U+202A`–`U+202E`, `U+2066`–`U+2069`)                                              |
| Replaced with `_`  | `/ \ : * ? " < > \|` and any leading `.`                                                                                        |
| Path segments      | `..` and `.` collapsed; only the basename is kept                                                                               |
| Reserved (Windows) | `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` get a `_` suffix                                                       |
| Extension          | **Recomputed** from the validated content-type; the client's is discarded                                                       |

**Why RTL overrides are stripped rather than escaped.** `invoice‮gnp.exe` renders as
`invoice­exe.png` — a reviewer sees a PNG and clicks an executable. That the file must still pass
magic-byte validation makes it non-fatal here, but the rendering deceives a human, and an ops console
is exactly where a human decides.

### Magic-byte enforcement (R-FILE-5)

| Declared          | Required leading bytes       |
| ----------------- | ---------------------------- |
| `image/jpeg`      | `FF D8 FF`                   |
| `image/png`       | `89 50 4E 47 0D 0A 1A 0A`    |
| `image/webp`      | `52 49 46 46 …. 57 45 42 50` |
| `application/pdf` | `25 50 44 46`                |
| `video/mp4`       | `…. 66 74 79 70` at offset 4 |

The declared content-type is a **claim**; these bytes are the evidence. They must agree.

---

## 6. Rate limits (R-FILE-9)

| Axis                                  | Limit | Response           |
| ------------------------------------- | ----- | ------------------ |
| Uploads per user per hour             | 30    | `429 RATE_LIMITED` |
| Uploads per user per purpose per hour | 10    | `429 RATE_LIMITED` |
| Read URLs per user per minute         | 60    | `429 RATE_LIMITED` |

Keyed in Redis, same limiter primitives AUTH's OTP axes use. The strictest axis wins, and
`retryAfterSec` mirrors the `Retry-After` header.

---

## 6A. Module integration matrix

Who may do what, and through which surface. **`files` has no notion of "module" at runtime** — every
row below resolves to the read policy in §4 plus the caller's ownership. The table exists so a module
author knows what to expect before writing code, not because the code branches on it.

| Module                  | Upload                          | Read                                        | Delete                                                        | Supersede           |
| ----------------------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------- |
| `users`                 | ✅ `PROFILE_IMAGE`              | ✅ own                                      | ✅ own                                                        | ✅ on avatar change |
| `drivers` / `documents` | ✅ via the driver's own session | ✅ own; ops with `drivers:verify` (audited) | ❌ — a KYC document is evidence; it supersedes, never deletes | ✅ on renewal       |
| `vehicles`              | ✅ owner's session              | ✅ own; ops (audited)                       | ❌ same reasoning                                             | ✅ on reissue       |
| `sos`                   | ✅ `SOS_EVIDENCE`               | ✅ own; ops `safety:read`                   | ❌ **never**                                                  | ❌ **never**        |
| `support`               | ✅ `DISPUTE_EVIDENCE`           | ✅ own; ops `support:read`                  | ❌ until closed + window                                      | ❌                  |
| `admin`                 | ❌                              | ✅ per §4 scopes, audited                   | ⬜ future                                                     | ❌                  |

Three rules are doing the work here:

1. **Nothing uploads on a user's behalf.** Every upload is authenticated as the file's owner, so
   `owner_user_id` is never inferred. A module that wanted to upload "for" a user would be creating
   evidence in that user's name.
2. **Evidence is superseded, never deleted.** The ❌ in the Delete column for KYC, SOS, and dispute
   files is R-FILE-32, not an oversight — `DELETE /files/{id}` returns `409 FILE_IN_USE` while a live
   row references them, and after that retention owns them.
3. **`admin` reads; it does not write.** Every ops interaction with a file is a read, and every one
   is audited (05 §3.2). An ops actor who could delete evidence is the threat model, not a feature.

---

## 7. What this module does not expose

| Not exposed                    | Why                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------- |
| A list endpoint (`GET /files`) | Nothing needs it. The owning module lists its own documents and resolves ids. |
| The storage key                | FILE-INV-2 — it is an internal coordinate, and an unguessable one by design.  |
| The bucket or provider name    | Would leak infrastructure into a client contract.                             |
| A stable/permanent URL         | R-FILE-12 — there is no such thing here, by construction.                     |
| Server-side byte upload        | FILES-OD-1 — the whole point of the two-step protocol.                        |

---

## 8. Traceability

| Endpoint                   | Realizes                        | Errors (04) | Events (05)                          |
| -------------------------- | ------------------------------- | ----------- | ------------------------------------ |
| `POST /files`              | R-FILE-1..4, 7..9               | §2.1        | —                                    |
| `POST /files/:id/complete` | R-FILE-5, 6, 10, 24; FILE-INV-6 | §2.2        | `file.uploaded`                      |
| `GET /files/:id/url`       | R-FILE-11..16; FILE-INV-4       | §2.3        | `file.read` (audit, privileged only) |
| `GET /files/:id`           | R-FILE-13, 14                   | §2.3        | —                                    |
| `DELETE /files/:id`        | R-FILE-18, 19; FILE-INV-5       | §2.4        | `file.deleted`                       |
