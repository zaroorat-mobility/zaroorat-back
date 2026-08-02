# FILES — Error Catalog

> **Project:** Zaroorat — Ride-Hailing Platform
> **Module:** `files` · **Doc:** 04 of the FILES chain · **Stack:** Fastify / TypeScript (ADR-0006)
> **Status:** 🟡 Specified (v1) · **Owner:** Engineering (Platform) · **Last updated:** 2026-08-02
> **Answers:** _What does every failure look like on the wire, and how should the client react?_
> **Traces from:** [02_API](02_FILES_API_SPEC.md) · [AUTH 05](../auth/05%20auth%20error%20catalog.md) (the envelope) · [USER 04](../user/04_USER_ERROR_CATALOG.md) (the extension pattern)
> **Traces to:** 06_TEST_PLAN §5

---

## 1. Envelope — shared, unchanged

FILES defines no error shape. It reuses the platform envelope implemented in
`src/modules/auth/http/error-response.ts`, exactly as USER does:

```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "messageKey": "file.upload.too_large",
    "message": "That file is larger than the 10 MB limit.",
    "requestId": "req_8f2c…",
    "details": [{ "field": "sizeBytes", "code": "OUT_OF_RANGE", "limit": 10485760 }]
  }
}
```

The status map extends the shared table with the FILES-only codes in §2.2; the resolver keeps the
same shape, so one error handler still serves all three modules.

**A FILES error never contains:** a signed URL, a storage key, a bucket or provider name, a
provider's own error text, a stack trace, another user's id, or the `fileName` of a file the caller
cannot read (FILE-INV-2, §5).

---

## 2. Catalog

### 2.1 Reused platform codes

No new meanings. Listed with their FILES trigger so the client's existing handling applies.

| `code`                | HTTP | FILES trigger                                                                             |
| --------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `VALIDATION`          | 400  | Bad body, unknown `purpose`, absent `Idempotency-Key` on `POST /files`                    |
| `NOT_FOUND`           | 404  | No such file — **or** one the read policy denies (§4)                                     |
| `CONFLICT`            | 409  | State-machine refusal: completing a file that is not `PENDING`                            |
| `RATE_LIMITED`        | 429  | Any axis in [02 §6](02_FILES_API_SPEC.md#6-rate-limits-r-file-9); carries `retryAfterSec` |
| `SERVICE_UNAVAILABLE` | 503  | The storage provider is unreachable (§6)                                                  |

`FORBIDDEN` is **absent by design.** Returning it would confirm a file exists (§4).

### 2.2 FILES-specific codes

| `code`                   | HTTP | Meaning                                                      | Client should                                     |
| ------------------------ | ---- | ------------------------------------------------------------ | ------------------------------------------------- |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | `contentType` not permitted for this `purpose`               | Show the allowed types from `details.allowed`     |
| `FILE_TOO_LARGE`         | 413  | Declared or actual size exceeds the purpose ceiling          | Downscale and retry; show `details[].limit`       |
| `UPLOAD_NOT_FOUND`       | 409  | Completion called, but no object is at the key               | Re-PUT the bytes, then retry completion           |
| `CONTENT_MISMATCH`       | 422  | The stored bytes are not the declared type (magic-byte fail) | **Do not retry.** Re-pick the file                |
| `CHECKSUM_MISMATCH`      | 422  | Declared checksum ≠ stored object's                          | Re-upload; the transfer corrupted                 |
| `UPLOAD_EXPIRED`         | 410  | The permission window closed before completion               | Start over at `POST /files`                       |
| `FILE_IN_USE`            | 409  | A live domain row still references this file                 | Detach it first; `details.module` names the owner |

### 2.3 Where each one fires

| Endpoint                    | Can return                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /files`               | `VALIDATION`, `UNSUPPORTED_MEDIA_TYPE`, `FILE_TOO_LARGE`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`                                                 |
| `POST /files/{id}/complete` | `NOT_FOUND`, `CONFLICT`, `UPLOAD_NOT_FOUND`, `UPLOAD_EXPIRED`, `FILE_TOO_LARGE`, `CONTENT_MISMATCH`, `CHECKSUM_MISMATCH`, `SERVICE_UNAVAILABLE` |
| `GET /files/{id}/url`       | `NOT_FOUND`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`                                                                                              |
| `GET /files/{id}`           | `NOT_FOUND`                                                                                                                                     |
| `DELETE /files/{id}`        | `NOT_FOUND`, `FILE_IN_USE`                                                                                                                      |

---

## 3. Why `CONTENT_MISMATCH` is 422 and not 400

`400` says "your request was malformed" — but the request that failed is an **empty POST**. Nothing
about it was malformed. What is wrong is the _state the client created out of band_: bytes that
disagree with what it declared. `422 Unprocessable Content` is precisely that distinction, and the
difference matters to a client's retry logic: a `400` invites fixing the request and resending the
same one, which here would loop forever.

The same reasoning applies to `CHECKSUM_MISMATCH` — except that one _is_ worth retrying, because a
corrupt transfer is transient. The two codes differ so the client can tell those apart.

---

## 4. The `NOT_FOUND` merge — FILE-INV-4

Three distinct situations return **byte-identical** `404` responses:

1. No file with that id has ever existed.
2. A file exists, owned by someone else, and the caller has no ops scope for its purpose.
3. A file exists, owned by the caller, but is soft-deleted.

Nothing in the body, the headers, or the timing distinguishes them. This is the same rule USER
applies to emergency contacts and saved places (USER-INV-2), for the same reason: a `403` is an
existence oracle. Given a file id, an attacker who could tell (1) from (2) could confirm that a
specific document exists for a specific driver.

The cost is a worse developer experience when someone genuinely mistypes an id — accepted, and the
reason `requestId` is in every envelope: support can resolve the real cause from logs, where it is
safe to record.

**Not merged:** `CONFLICT` for a non-`PENDING` completion. By then the caller has already proven
ownership, so there is nothing left to disclose.

---

## 5. What never appears in an error

| Never                       | Because                                                   |
| --------------------------- | --------------------------------------------------------- |
| A signed URL                | FILE-INV-2 — it is a bearer credential                    |
| A storage key               | R-FILE-7 — unguessability is a security property          |
| Bucket / provider / region  | Leaks infrastructure into a client contract               |
| The provider's error text   | Vendor prose leaks topology and confuses clients (§6)     |
| Another user's `fileName`   | A filename is user-authored and frequently identifying    |
| Byte offsets or magic bytes | Tells an attacker exactly how to shape a file that passes |

`details` carries only: the offending **field name**, a machine `code`, and where useful a numeric
`limit` or an `allowed` list — the same discipline USER's `LIMIT_EXCEEDED` follows.

---

## 6. Provider failures fail closed

Every storage call is wrapped. A timeout, a refused connection, or a 5xx from the provider becomes
`503 SERVICE_UNAVAILABLE` with a `Retry-After` — never a `200` with a null URL, and never the
provider's own message.

| Provider state   | `POST /files` | `complete`             | `GET /url` |
| ---------------- | ------------- | ---------------------- | ---------- |
| Unreachable      | `503`         | `503`                  | `503`      |
| Object missing   | n/a           | `UPLOAD_NOT_FOUND` 409 | `503` ¹    |
| Signing rejected | `503`         | n/a                    | `503`      |

¹ A `READY` row whose object has vanished is **not** a client error — it is data loss, and the
client can do nothing about it. It returns `503`, logs at `error`, and is exactly the signal the
retention job's reference guard exists to prevent.

This mirrors AUTH's fail-closed posture: a dependency that cannot answer must never be read as
permission (AUTH 02 §7).

---

## 7. Traceability

| Code group                        | Realizes                  | Proven by (06) |
| --------------------------------- | ------------------------- | -------------- |
| §2.1 reuse                        | one envelope, one handler | §5             |
| `UNSUPPORTED_*`, `FILE_TOO_LARGE` | R-FILE-3, R-FILE-4        | §3 #2, §5      |
| `CONTENT_MISMATCH`                | R-FILE-5, acceptance #2   | §5             |
| `NOT_FOUND` merge                 | R-FILE-14, FILE-INV-4     | §4, §5         |
| `FILE_IN_USE`                     | R-FILE-19, FILE-INV-5     | §6             |
| §6 fail-closed                    | NFR-7, AUTH 02 §7         | §5             |
