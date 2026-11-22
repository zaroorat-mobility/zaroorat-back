# OTP Production Codebase Audit

**Scope:** discovery only. No code was modified, created, or deleted.
**Date:** 2026-08-15 · **Branch:** `feature/auth` · **Audited revision:** `290b3c6`

---

## 1. Executive Summary

The OTP system already exists and is more complete than a greenfield assumption would suggest. It is cryptographically sound, Redis-backed, single-use, purpose-scoped, rate-limited on three axes, and has a Postgres audit trail that deliberately stores no secret. The verify path is well-tested and defends against challenge-substitution, enumeration, and expiry-counted-as-failure.

The gap is **delivery**, not verification.

SMS is sent **synchronously and inline** inside `POST /api/v1/auth/otp/send`, with **no timeout, no retry, and no queue**. When MSG91 fails, the API still returns `200 OK` with a `challengeId`, the OTP stays valid in Redis for 5 minutes, and the customer never receives it. The customer's only recourse is to wait out a 60-second cooldown and re-request — which consumes one of only **3 per-phone requests per hour**. Three provider failures in an hour lock the customer out of the product entirely for up to an hour, with no operator visibility beyond a `warn` log line.

BullMQ **is** already installed and running (v6.0.7), but only for six cron-driven maintenance queues. There are no event-driven producers or consumers — `src/jobs/producers/index.ts` and `src/jobs/consumers/index.ts` are empty stubs. Critically, **the worker process is not deployed anywhere**: it is absent from `docker-compose.yml` and from the Helm chart, so even today's scheduled jobs (including the auth retention purge) never run in production.

Highest-severity findings: synchronous unbounded SMS call in the request path (C-1), silent delivery failure returned as success (C-2), worker process not deployed (C-3), full phone numbers written to logs unmasked (C-4), and a shared un-namespaced idempotency keyspace (H-3).

---

## 2. Current Architecture

```
Client
  │
  ├─ POST /api/v1/auth/otp/send ──► Fastify route (public)
  │      │                            └─ preHandler: app.rateLimit(rateLimits.otpSend)  [per-IP 20/h]
  │      ├─ AuthController.sendOtp     └─ zod validate
  │      ├─ AuthService.sendOtp        └─ injects purpose = 'LOGIN'
  │      └─ OtpService.send
  │             ├─ RedisService.otp.getChallenge   (cooldown short-circuit)
  │             ├─ OtpRateLimiter.checkSend        (phone / device / ip)
  │             ├─ OtpGenerator.generate           (node:crypto randomInt)
  │             ├─ RedisService.otp.store          (HMAC digest, EX 300)
  │             ├─ EventPublisher  auth.otp.requested → outbox
  │             ├─ NotificationService.sendOtp ──► Msg91Provider ──► fetch()   ◄── BLOCKING
  │             ├─ OtpRepository.create            (Postgres audit row)
  │             └─ RedisService.otp.setChallenge   (EX 60 = cooldown)
  │
  └─ POST /api/v1/auth/otp/verify ─► Fastify route (public)
         │                            └─ preHandler: app.rateLimit(rateLimits.otpVerify) [per-IP 10/15m]
         ├─ AuthController.verifyOtp  └─ requires Idempotency-Key header
         ├─ AuthService.verifyOtp     └─ IdempotencyStore.runOnce (TTL 24h)
         ├─ OtpService.verify
         │      ├─ OtpRateLimiter.isLocked
         │      ├─ assertChallengeBelongsToCaller (Postgres)
         │      ├─ RedisService.otp.consume        (atomic Lua GET+DEL)
         │      └─ attempts / lockout / outcome recording
         └─ Transaction: user upsert → profile → device → session → token pair
```

**Process topology today:** one process type (`dist/server.js`). The worker (`dist/worker.js`) exists in code but is not deployed.

**Stack:** Fastify 5 · Awilix DI (CLASSIC injection) · Prisma 7 / PostgreSQL · ioredis 5 · BullMQ 6 · pino 10 · zod 4.

---

## 3. Repository Structure

| Path                                                  | Role                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/modules/auth/`                                   | Authentication module — OTP, sessions, tokens, devices, roles                 |
| `src/modules/auth/services/otp/`                      | **The OTP implementation** (5 classes)                                        |
| `src/modules/notifications/`                          | SMS abstraction + MSG91 and mock providers                                    |
| `src/core/cache/`                                     | `RedisService` facade + 6 purpose-built Redis stores                          |
| `src/core/cache/stores/OtpStore.ts`                   | All OTP Redis primitives (Lua-backed)                                         |
| `src/jobs/`                                           | BullMQ queues, workers, cron scheduler; `producers/` + `consumers/` are empty |
| `src/config/otp/otp.config.ts`                        | Every OTP tunable                                                             |
| `src/config/rate-limit/rate-limit.config.ts`          | HTTP-layer rate limits                                                        |
| `src/plugins/rate-limit/`                             | `app.rateLimit()` preHandler decorator                                        |
| `src/core/metrics/registry.ts`                        | In-process Prometheus text-exposition registry                                |
| `prisma/schema/modules/auth/auth.prisma`              | `OtpVerification` audit model                                                 |
| `src/worker.ts` / `src/bootstrap/worker.bootstrap.ts` | Worker entrypoint (**undeployed**)                                            |
| `infrastructure/helm/`                                | Single API Deployment; no worker workload                                     |
| `observability/`                                      | `alerts/`, `grafana/`, `loki/`, `prometheus/` — **all empty**                 |

**Dependency evidence** (`package.json:38-57`): `bullmq@^6.0.7`, `ioredis@^5.11.1`, `pino@^10.3.1`. No SMS SDK is installed — MSG91 is called with the platform `fetch`. No Sentry, OpenTelemetry, or Datadog package is present anywhere.

---

## 4. OTP Send Flow

**Real route:** `POST /api/v1/auth/otp/send` (prefix from `src/routes/register.ts:21`, path from `src/modules/auth/routes/auth.routes.ts:28`).

| Step                    | File                                                    | Function / Line              |
| ----------------------- | ------------------------------------------------------- | ---------------------------- |
| Route + schema          | `src/modules/auth/routes/auth.routes.ts`                | `registerAuthRoutes`, L27-49 |
| HTTP rate limit         | `src/plugins/rate-limit/rate-limit.plugin.ts`           | `rateLimitHandler`, L62-104  |
| Controller              | `src/modules/auth/controllers/auth.controller.ts`       | `sendOtp`, L63-84            |
| Body validation         | `src/modules/auth/schemas/auth.schemas.ts`              | `sendOtpSchema`, L22-25      |
| Purpose injection       | `src/modules/auth/services/auth.service.ts`             | `sendOtp`, L89-98            |
| Cooldown short-circuit  | `src/modules/auth/services/otp/otp.service.ts`          | `send`, L71-78               |
| Multi-axis rate limit   | `src/modules/auth/services/otp/otp.rate-limiter.ts`     | `checkSend`, L25-43          |
| OTP generation          | `src/modules/auth/services/otp/otp.generator.ts`        | `generate`, L11-17           |
| OTP storage             | `src/core/cache/stores/OtpStore.ts`                     | `store`, L29-31              |
| Event publish           | `src/modules/auth/services/otp/otp.service.ts`          | L99-101                      |
| **SMS send (blocking)** | `src/modules/auth/services/otp/otp.service.ts`          | L103-105                     |
| Provider call           | `src/modules/notifications/providers/msg91.provider.ts` | `sendSms`, L21-65            |
| Audit row               | `src/modules/auth/repositories/otp.repository.ts`       | `create`, L33-51             |
| Cooldown set            | `src/core/cache/stores/OtpStore.ts`                     | `setChallenge`, L61-73       |
| Response                | `src/modules/auth/services/otp/otp.service.ts`          | L150-154                     |

**Response body** (`src/modules/auth/schemas/auth.responses.ts:3-7`): `{ challengeId, expiresInSec, resendAvailableInSec }`.

**Ordering note:** the OTP is written to Redis (L92) _before_ SMS is attempted (L104), and the audit row is written _after_ (L107). The `challengeId` returned to the client is therefore the Postgres row id, which does not exist until after the provider has responded.

---

## 5. OTP Verify Flow

**Real route:** `POST /api/v1/auth/otp/verify` (`src/modules/auth/routes/auth.routes.ts:52`).

| Step                     | File                                                | Function / Line                            |
| ------------------------ | --------------------------------------------------- | ------------------------------------------ |
| Route + schema           | `src/modules/auth/routes/auth.routes.ts`            | L51-78                                     |
| HTTP rate limit          | `src/plugins/rate-limit/rate-limit.plugin.ts`       | L62-104                                    |
| Idempotency-Key required | `src/modules/auth/controllers/auth.controller.ts`   | `requireIdempotencyKey`, L193-200          |
| Body validation          | `src/modules/auth/schemas/auth.schemas.ts`          | `verifyOtpSchema`, L27-32                  |
| Idempotency wrapper      | `src/modules/auth/services/auth.service.ts`         | `verifyOtp`, L100-105                      |
| Lockout gate             | `src/modules/auth/services/otp/otp.service.ts`      | `verify`, L160-162                         |
| Challenge ownership      | `src/modules/auth/services/otp/otp.service.ts`      | `assertChallengeBelongsToCaller`, L202-230 |
| Format check             | `src/modules/auth/services/otp/otp.validator.ts`    | `isValidFormat`, L10-12                    |
| Atomic compare + consume | `src/core/cache/stores/OtpStore.ts`                 | `consume`, L33-41 (Lua L17-18)             |
| Attempt handling         | `src/modules/auth/services/otp/otp.rate-limiter.ts` | `registerFailedAttempt`, L49-59            |
| Expiry detection         | `src/modules/auth/services/otp/otp.service.ts`      | `isExpiredChallenge`, L232-236             |
| Outcome recording        | `src/modules/auth/repositories/otp.repository.ts`   | `updateOutcome`, L57-71                    |
| User upsert              | `src/modules/auth/services/auth.service.ts`         | `resolveAccount`, L377-408                 |
| Session + tokens         | `src/modules/auth/services/auth.service.ts`         | `runVerifyOtp`, L115-199                   |
| Session cap              | `src/modules/auth/services/auth.service.ts`         | L201-205                                   |

**Error → HTTP mapping** (`src/modules/auth/schemas/error-response.ts:4-20`): `OTP_INVALID` → 401, `OTP_EXPIRED` → 410, `OTP_LOCKED` → 429, `RATE_LIMITED` → 429, `IDEMPOTENCY_IN_PROGRESS` → 409.

---

## 6. OTP Generation

**Implementation** — `src/modules/auth/services/otp/otp.generator.ts:11-17`:

```ts
generate(): string {
  let code = '';
  for (let i = 0; i < this.length; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}
```

| Question                       | Answer                                              | Evidence                                                                      |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Cryptographically secure?      | **Yes**                                             | `randomInt` from `node:crypto` (`otp.generator.ts:1`)                         |
| `Math.random()` used?          | **No** — nowhere in the OTP path                    | —                                                                             |
| Length                         | 6 digits, configurable via `OTP_CODE_LENGTH`        | `src/config/otp/otp.config.ts:13`                                             |
| Leading zeros                  | **Supported** — built as a string, never coerced    | `otp.generator.ts:12-15`; asserted in `tests/unit/auth/otp-generator.test.ts` |
| Stored plaintext?              | **No**                                              | —                                                                             |
| Hashed?                        | **Yes** — HMAC-SHA256 with a pepper                 | `src/modules/auth/services/otp/otp.hasher.ts:11-13`                           |
| Encrypted?                     | No (hashing is the correct choice here)             | —                                                                             |
| Validity                       | 300s (`OTP_TTL_SECONDS`)                            | `otp.config.ts:14`; enforced as Redis `EX` in `OtpStore.ts:30`                |
| Multiple OTPs per phone?       | **No** for a given purpose — `SET` overwrites       | `OtpStore.ts:30`                                                              |
| Multiple OTPs across purposes? | **Yes, by design** — key is `otp:{purpose}:{phone}` | `src/core/cache/keys.ts:2`                                                    |
| New OTP invalidates old?       | **Yes** (same purpose)                              | plain `SET`, no `NX` — `OtpStore.ts:30`                                       |
| Reuse possible?                | **No** — atomic compare-and-delete                  | Lua `OtpStore.ts:17-18`                                                       |

**Pepper derivation** (`otp.config.ts:4-10`): `OTP_PEPPER` if set, otherwise `HMAC-SHA256(JWT_REFRESH_SECRET, 'zaroorat:otp:pepper:v1')`. `OTP_PEPPER` is documented in no `.env` file. Consequence: rotating `JWT_REFRESH_SECRET` silently invalidates every in-flight OTP.

**Entropy note:** 6 digits = 10⁶ space, 5 attempts before lockout — an online guess has a 1-in-200,000 chance per lockout window. Adequate for this design.

---

## 7. Redis

**Client:** `ioredis@^5.11.1`. Single shared connection created in `src/core/cache/client.ts:8-15`:

```ts
new Redis(config.redis.url, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
```

Configuration is a single `REDIS_URL` (`src/config/redis/redis.config.ts:3-5`), required by the env schema (`src/config/env/schema.ts:16`). No Sentinel, Cluster, TLS, or separate read replica configuration exists.

**Facade:** `RedisService` (`src/core/cache/RedisService.ts`) exposes six stores: `otp`, `epoch`, `sidBlacklist`, `rateLimit`, `idempotency`, `lock`.

**Actual OTP keys** — verbatim from `src/core/cache/keys.ts:2-15`:

```
otp:{purpose}:{phone}              # OTP HMAC digest        TTL 300s   (OtpStore.store)
otp:att:{phone}                    # failed verify counter  TTL 900s   (OtpStore.incrementAttempts)
otp:lock:{phone}                   # lockout flag           TTL 900s   (OtpStore.lock)
otp:challenge:{purpose}:{phone}    # challengeId + cooldown TTL 60s    (OtpStore.setChallenge)
ratelimit:otp:req:{phone}          # per-phone send limit   TTL 3600s
ratelimit:otp:dev:{deviceId}       # per-device send limit  TTL 3600s
ratelimit:otp:ip:{ip}              # per-IP send limit      TTL 3600s
ratelimit:rl:otp-send:ip:{ip}      # HTTP-layer send limit  TTL 3600s
ratelimit:rl:otp-verify:ip:{ip}    # HTTP-layer verify limit TTL 900s
idem:{key}                         # idempotency record     TTL 86400s
lock:{resource}                    # distributed lock (PX)
```

Note the attempt and lock keys are **not** purpose-scoped: a failed `PHONE_CHANGE` verify increments the same counter that locks out `LOGIN`.

**Atomicity — three Lua scripts, all correct:**

| Script                   | Location                  | Purpose                                                                         |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------- |
| `CONSUME_LUA`            | `OtpStore.ts:17-18`       | `GET`; `DEL` only if the digest matches — makes verify single-use and race-free |
| `INCREMENT_ATTEMPTS_LUA` | `OtpStore.ts:20-23`       | `INCR` + `EXPIRE` on first hit — no unbounded counter                           |
| `HIT_LUA`                | `RateLimitStore.ts:15-18` | `INCR` + `EXPIRE` + `TTL` in one round trip                                     |

**Locks:** `LockStore` (`src/core/cache/stores/LockStore.ts`) implements `SET NX PX` + token-checked Lua release. It is used by `AuthRetentionJob` only — **not** by the OTP send path.

**Redis is REQUIRED for authentication.** It is not a cache. Losing Redis means: no OTP can be issued or verified, the rate-limit plugin fails closed with 503 (`rate-limit.plugin.ts:80-92`), and `OtpService`'s own Redis calls throw into the generic 500 handler. Redis is also shared by BullMQ (separate connections, `src/jobs/queues/index.ts:33-35`), the session-epoch store, the sid blacklist, and idempotency.

**TTL handling** is uniformly Redis-native (`EX`/`PX`); nothing sweeps keys in application code.

---

## 8. BullMQ / Queues

**BullMQ IS currently implemented** — `bullmq@^6.0.7` (`package.json:50`) — but **no OTP queue exists**.

**Queue names** (`src/jobs/queues/index.ts:6-14`): `files-maintenance`, `users-maintenance`, `auth-maintenance`, `rides-maintenance`, `drivers-maintenance`, `payments-maintenance`.

**Job names** (`src/jobs/queues/index.ts:18-29`): `file-sweep`, `file-retention`, `account-erasure`, `auth-retention`, `dispatch-timeout`, `request-expiry`, `driver-heartbeat-timeout`, `driver-doc-expiration`, `payment-reconciliation`.

| Aspect               | Current state                                                                                   | Evidence                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Producers            | **None.** Only the cron scheduler enqueues. `src/jobs/producers/index.ts` is `export {}`        | `src/jobs/scheduler/index.ts:70-83`              |
| Consumers            | `src/jobs/consumers/index.ts` is `export {}`                                                    | —                                                |
| Workers              | One per queue, all running the same generic handler                                             | `src/jobs/workers/index.ts:57-76`                |
| Handler dispatch     | Job name → Awilix registration name → `.run(now)`                                               | `MAINTENANCE_HANDLERS`, `workers/index.ts:33-43` |
| Redis connection     | **New `ioredis` per queue and per worker**, `maxRetriesPerRequest: null`                        | `queues/index.ts:33-35`                          |
| Concurrency          | `1`                                                                                             | `workers/index.ts:61`                            |
| Retry                | **`attempts: 1`** — no retry at all                                                             | `MAINTENANCE_JOB_OPTIONS`, `queues/index.ts:38`  |
| Backoff              | **Not configured**                                                                              | —                                                |
| Job retention        | `removeOnComplete: {count:100}`, `removeOnFail: {count:500}`                                    | `queues/index.ts:39-40`                          |
| Dead-letter handling | **NOT IMPLEMENTED**                                                                             | —                                                |
| Worker startup       | `src/worker.ts` → `startWorker()`                                                               | `src/bootstrap/worker.bootstrap.ts:16-34`        |
| Graceful shutdown    | SIGINT/SIGTERM → drain workers → close queues → disconnect Prisma → `redis.quit()`, 120s grace  | `worker.bootstrap.ts:36-68`                      |
| Monitoring           | Only `completed`/`failed` pino log lines. No `QueueEvents`, no Bull Board, no queue-depth gauge | `workers/index.ts:64-70`                         |
| Scheduling           | `queue.upsertJobScheduler` with cron patterns, TZ `Etc/UTC`                                     | `scheduler/index.ts:70-83`                       |

The shutdown and scheduler machinery is production-grade and directly reusable. What is missing for OTP is a producer, a dedicated queue, retry/backoff policy, and a DLQ.

---

## 9. SMS Provider

| Aspect               | Finding                                                                                          | Evidence                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Provider             | **MSG91** (Flow API v5)                                                                          | `src/modules/notifications/providers/msg91.provider.ts:17` |
| SDK                  | **None** — raw `fetch`                                                                           | `msg91.provider.ts:36`                                     |
| Auth                 | `authkey` header                                                                                 | `msg91.provider.ts:38`                                     |
| **Timeout**          | **NONE** — no `AbortSignal`, no `signal:` option                                                 | `msg91.provider.ts:36-44`                                  |
| **Retry**            | **NONE** — single attempt, failure returned as a value                                           | `msg91.provider.ts:21-65`                                  |
| Error handling       | try/catch → `{ accepted: false, error }`; never throws                                           | `msg91.provider.ts:49-64`                                  |
| HTTP status handling | `!res.ok \|\| payload.type === 'error'` → rejected. **No distinction between 4xx, 429, and 5xx** | `msg91.provider.ts:49`                                     |
| Provider response    | `request_id` captured as `providerRef`                                                           | `msg91.provider.ts:58`                                     |
| Delivery status      | **NOT IMPLEMENTED** — accepted ≠ delivered                                                       | —                                                          |
| Webhooks (DLR)       | **NOT IMPLEMENTED** — no route, no handler                                                       | —                                                          |
| Sender ID            | `MSG91_SENDER_ID`, optional                                                                      | `notification.config.ts:21`                                |
| Templates            | `MSG91_OTP_TEMPLATE_ID` required; without it MSG91 refuses before any network call               | `msg91.provider.ts:22-28`, `notification.config.ts:27-29`  |
| Country restrictions | **None**; `+` stripped from E.164                                                                | `msg91.provider.ts:67-69`                                  |
| Logging              | Logs **full phone number** at `error` level                                                      | `msg91.provider.ts:51, 62`                                 |

**Provider selection** (`src/modules/notifications/notification.config.ts:14-31`):

```ts
const smsProvider = explicit ?? (env === 'production' || env === 'staging' ? 'msg91' : 'mock');
```

`SMS_PROVIDER=mock` **overrides production** and silently routes every OTP to `MockProvider`, which accepts everything and delivers nothing. Neither `SMS_PROVIDER`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, nor `MSG91_OTP_TEMPLATE_ID` appears in `.env.example`, `.env.production`, or the Helm values.

**Exact code path:**

```
AuthService.sendOtp            src/modules/auth/services/auth.service.ts:89
  └─ OtpService.send           src/modules/auth/services/otp/otp.service.ts:104
       └─ NotificationService.sendOtp   src/modules/notifications/notification.service.ts:24
            └─ Msg91Provider.sendSms    src/modules/notifications/providers/msg91.provider.ts:21
                 └─ fetch(control.msg91.com/api/v5/flow/)
```

**Does the API wait for the provider before responding? YES.** `otp.service.ts:104` is an unguarded `await` inside the request handler. Provider latency is customer-visible latency, and provider hang is customer-visible hang.

---

## 10. Retry Behavior

**There is no retry anywhere in the OTP delivery path** — not in the provider, not in the service, not in a queue.

| Layer                         | Retry?        | Evidence                                                 |
| ----------------------------- | ------------- | -------------------------------------------------------- |
| `Msg91Provider.sendSms`       | No            | `msg91.provider.ts:21-65` — one `fetch`, result returned |
| `NotificationService.sendOtp` | No            | `notification.service.ts:24-34` — pass-through           |
| `OtpService.send`             | No            | `otp.service.ts:130-135` — logs a warning, continues     |
| Queue                         | N/A           | No OTP job exists                                        |
| Client                        | Implicit only | Customer must re-request after the 60s cooldown          |

`MAINTENANCE_JOB_OPTIONS.attempts = 1` (`queues/index.ts:38`) means even existing BullMQ jobs do not retry, so there is no established retry/backoff pattern in the repo to copy.

---

## 11. Rate Limiting

### Per phone

| Control               | Value                                                                 | Where                                                    |
| --------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Send requests         | **3 per 3600s** (`OTP_LIMIT_PHONE` / `OTP_WINDOW_PHONE`)              | `otp.config.ts:20-24`; enforced `otp.rate-limiter.ts:29` |
| Requests per minute   | Not a distinct limit — covered by cooldown                            | —                                                        |
| Cooldown / resend gap | **60s** (`OTP_RESEND_INTERVAL_SECONDS`) via `otp:challenge:*` key TTL | `otp.config.ts:17`; `otp.service.ts:71-78`, `123-128`    |
| Verify attempts       | **5** then lock (`OTP_MAX_VERIFY_ATTEMPTS`)                           | `otp.config.ts:15`; `otp.rate-limiter.ts:54`             |
| Lockout               | **900s** (`OTP_LOCKOUT_SECONDS`)                                      | `otp.config.ts:16`; `otp.rate-limiter.ts:55`             |
| Verify requests/hour  | **NOT IMPLEMENTED** per phone (only per IP)                           | —                                                        |

### Per IP

| Control                | Value                         | Where                        |
| ---------------------- | ----------------------------- | ---------------------------- |
| Send — service layer   | 20 per 3600s                  | `otp.config.ts:30-33`        |
| Send — HTTP layer      | 20 per 3600s (`rl:otp-send`)  | `rate-limit.config.ts:11-16` |
| Verify — HTTP layer    | 10 per 900s (`rl:otp-verify`) | `rate-limit.config.ts:4-9`   |
| Verify — service layer | **NOT IMPLEMENTED**           | —                            |

### Per device

| Control      | Value                                                                               | Where                 |
| ------------ | ----------------------------------------------------------------------------------- | --------------------- |
| Identifier   | Client-supplied `device.deviceId`, 1–128 chars, **unvalidated and unauthenticated** | `auth.schemas.ts:11`  |
| Send limit   | 5 per 3600s                                                                         | `otp.config.ts:25-29` |
| Verify limit | **NOT IMPLEMENTED**                                                                 | —                     |

The device axis is trivially bypassed by omitting `deviceId` — `otp.rate-limiter.ts:32` skips the check entirely when it is absent.

### Global

```
NOT IMPLEMENTED
```

No system-wide OTP ceiling, no per-minute provider-spend cap, no circuit breaker, no country/prefix throttle. Nothing bounds total MSG91 spend if the per-IP and per-phone axes are attacked in parallel across many phones.

**Fail-closed behavior:** the HTTP rate-limit plugin returns 503 when Redis is unavailable (`rate-limit.plugin.ts:82-92`), except for the webhook scope which is explicitly `onStoreError: 'open'`.

**Dead code:** `RateLimitStore.enforceMinInterval` (`RateLimitStore.ts:46-56`) is a clean `SET NX EX` cooldown primitive with **zero call sites** anywhere in `src/` or `tests/`.

---

## 12. Idempotency

| Endpoint                              | Requires `Idempotency-Key`? | Evidence                                                                                                          |
| ------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/otp/send`          | **NO — NOT IMPLEMENTED**    | No header in the route schema (`auth.routes.ts:27-49`); controller does not read one (`auth.controller.ts:63-84`) |
| `POST /api/v1/auth/otp/verify`        | **Yes, mandatory**          | `auth.controller.ts:87-88`, `193-200`                                                                             |
| `POST /api/v1/auth/token/refresh`     | Yes, mandatory              | `auth.controller.ts:115-116`                                                                                      |
| `POST /api/v1/users/.../phone` verify | Yes                         | `phone-change.service.ts:113-120`                                                                                 |

**Storage:** Redis, key `idem:{key}` (`src/core/cache/keys.ts:13`).
**TTL:** 86400s (`IDEMPOTENCY_TTL_SECONDS`, `src/modules/auth/constants/auth.constants.ts:2`).

**Duplicate behavior** (`IdempotencyStore.runOnce`, `src/core/cache/stores/IdempotencyStore.ts:36-53`):

1. `SET NX` claims the key with `{state:'in_flight'}`.
2. Claim fails + stored record is `done` → the cached result is replayed.
3. Claim fails + still `in_flight` → `IdempotencyInFlightError` → HTTP **409**.
4. Operation throws → key is deleted, so a legitimate retry is permitted.

**Duplicate OTP requests create multiple jobs?** No jobs exist. Duplicate _send_ requests are absorbed by the 60s challenge cooldown (`otp.service.ts:71-78`), not by idempotency — but see H-2: that check is a read-then-write with no lock, so genuinely concurrent sends both proceed.

**Duplicate verification requests are protected**, and `tests/integration/auth-concurrency.test.ts` covers it.

**Defect:** the `idem:` namespace is flat. It is not scoped by endpoint, route, user, or request-body hash. A client that reuses one UUID across `/otp/verify` and `/token/refresh` receives the _other_ endpoint's cached response.

---

## 13. Authentication / Tokens

```
OTP verified (OtpService.verify)
    ↓
resolveAccount        auth.service.ts:377  — find active by phone, else create (P2002 race-safe)
    ↓
UserProfile ensured   auth.service.ts:119  — emits user.profile.created
    ↓
DeviceService.register auth.service.ts:129
    ↓
SessionService.createInTransaction  auth.service.ts:132 — loginMethod 'otp'
    ↓
TokenService.issuePair auth.service.ts:145
    ↓
SessionService.enforceCap auth.service.ts:201 — outside the transaction
```

| Item                  | Value                                                                                      | Evidence                                               |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| JWT implementation    | Custom, in `src/modules/auth/services/token/jwt.service.ts` (no `jsonwebtoken` dependency) | `package.json:38-57`                                   |
| Access token TTL      | **900s** (`JWT_ACCESS_TTL_SECONDS`)                                                        | `src/config/jwt/jwt.config.ts:31`                      |
| Refresh token TTL     | **2592000s / 30d** (`JWT_REFRESH_TTL_SECONDS`)                                             | `jwt.config.ts:32`                                     |
| Key rotation          | Multi-kid via `JWT_ACCESS_SECRETS_JSON` / `JWT_OLD_ACCESS_SECRET`                          | `jwt.config.ts:23-29`                                  |
| Refresh token storage | **HMAC hash only** in `refresh_tokens.token_hash`; raw token never persisted               | `prisma/schema/modules/auth/auth.prisma:36`            |
| Reuse detection       | Replaying a consumed refresh token revokes the whole family → 401 `TOKEN_REUSE`            | `auth.routes.ts:89-90`                                 |
| Session storage       | Postgres `user_sessions`                                                                   | `auth.prisma:10-31`                                    |
| Session epoch         | Redis-only, `auth:epoch:{userId}`                                                          | `keys.ts:7`                                            |
| Revoked sid blacklist | Redis, `auth:sid:revoked:{sid}`                                                            | `keys.ts:9`                                            |
| Session cap           | Role-dependent; privileged roles get a separate cap                                        | `auth.service.ts:430-435`                              |
| Logout                | Single session, or all devices; also `DELETE /me/sessions`, `DELETE /me/devices/:id`       | `auth.controller.ts:132-149`, `auth.routes.ts:105-215` |
| Account gating        | Deactivated → 403, suspended/deleted → 403, **after** OTP consumption                      | `auth.service.ts:410-414`                              |

---

## 14. Database

**OTP data lives in two systems, deliberately split:**

- **Redis** — the secret (HMAC digest), TTL, attempts, lockout, cooldown. Authoritative for verification.
- **PostgreSQL** — a purgeable audit/fraud trail with **no secret material**.

**Model** `OtpVerification` → table `otp_verifications` (`prisma/schema/modules/auth/auth.prisma:55-87`):

| Field                                                   | Type            | Note                                                                |
| ------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `id`                                                    | uuid v7, PK     | Returned to the client as `challengeId`                             |
| `userId`                                                | uuid?           | Null until the account exists                                       |
| `phoneNumber`                                           | String          | **Stored in plaintext, not indexed as hashed**                      |
| `purpose`                                               | `OtpPurpose`    | `LOGIN` / `REGISTER` / `PHONE_CHANGE`                               |
| `outcome`                                               | String?         | `sent` / `verified` / `failed` / `expired` / `locked`               |
| `attempts`                                              | Int @default(0) | **Never written by any code path**                                  |
| `ipAddress`                                             | Inet?           |                                                                     |
| `deviceId`                                              | uuid?           | Only set when the client sends a UUID (`otp.service.ts:27-29, 115`) |
| `deviceFingerprint`, `userAgent`                        | String?         | Fraud metadata                                                      |
| `provider`, `providerRef`, `latencyMs`, `failureReason` |                 | Delivery metadata                                                   |
| `verifiedAt`, `expiresAt`, `createdAt`                  | DateTime        |                                                                     |

**Indexes:** `phoneNumber`, `createdAt`, `expiresAt`. The `expiresAt` index exists specifically for the retention purge.

**Explicit design decision, quoted from `auth.prisma:74-75`:**

> `// No otp_hash: the secret is Redis-only. This is a purgeable fraud/audit trail (R-AUTH-22/26/30), never a verification store (doc 02 §4.5).`

**So: the auth OTP secret is intentionally Redis-only. Postgres is audit, not verification.**

**Cleanup:** `AuthRetentionJob` (`src/modules/auth/jobs/auth-retention.job.ts`) purges rows older than `OTP_TRAIL_RETENTION_DAYS` (default 30, `otp.config.ts:18`) in 1,000-row batches, max 200 batches per run, guarded by a Redis lock. Cron `30 4 * * *` UTC (`scheduler/index.ts:14`). **This job never runs today — see F-3 / C-3.**

**A second, unrelated OTP system exists.** `RideOtp` (`prisma/schema/modules/ride/ride.prisma:220-235`) stores `otp_hash` **in Postgres**, uses the same `OtpHasher` (`ride-otp.service.ts:1, 25`), a 4/6-digit code from `generateRideOtp` (`src/modules/rides/utils/otp.util.ts:4-10`), and is **never sent by SMS** — the plaintext is returned up the call stack to the rider (`lifecycle.service.ts:137, 158`). It is a ride-start PIN, not a delivery concern, but it shares `OtpHasher` and any pepper change affects both.

**Unused repository method:** `OtpRepository.countByPhoneSince` (`otp.repository.ts:73-77`) has no call sites.

---

## 15. Security

### Can these appear in logs today?

| Value                           | Can leak?                                                                                                                                                           | Evidence                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **OTP code**                    | **Yes, in dev/staging** — `MockProvider` logs `body` and `variables` (both contain the code) at `debug`, and the logger level is `debug` when `APP_ENV=development` | `mock.provider.ts:11-14`; `src/shared/logger/logger.ts:8`            |
| **Phone number**                | **Yes, in every environment**                                                                                                                                       | `msg91.provider.ts:51, 62` (`error`), `mock.provider.ts:10` (`info`) |
| SMS provider response           | Partially — `error` string and HTTP status are logged                                                                                                               | `msg91.provider.ts:51`                                               |
| Access token                    | No — redacted                                                                                                                                                       | `src/shared/logger/redact.ts:7`                                      |
| Refresh token                   | No — redacted                                                                                                                                                       | `redact.ts:8`                                                        |
| Verification code (verify path) | No — the request body is never logged                                                                                                                               | `on-request.hook.ts:5-16` logs only method/url/requestId             |

**Redaction paths** (`src/shared/logger/redact.ts:1-9`) cover: `req.headers.authorization`, `req.headers.cookie`, `password`, `confirmPassword`, `accessToken`, `refreshToken`, `jwt`. **`to`, `phoneNumber`, `phone`, `code`, `otp`, `mobiles`, `body`, and `variables` are all absent.**

A `maskPhone` helper exists (`src/modules/users/utils/phone.util.ts:1`) and is used correctly by the USERS module's phone-change events — but it is **not** used by the AUTH module, the notifications module, or the logger.

### What is done well

- OTP secret never touches Postgres (`auth.prisma:74`), never reaches an event payload, and never appears in a response — asserted by `tests/integration/auth-security.test.ts:68-96`.
- Refresh tokens stored as HMAC digests only, with reuse detection.
- Enumeration-safe: send returns an identical response for existing, non-existent, and closed accounts (`auth.routes.ts:36-38`); a foreign `challengeId` is reported exactly as a wrong code (`otp-service-verify.test.ts:207-231`).
- Expiry does not count toward lockout (`otp.service.ts:178-182`) — an availability-preserving choice, tested.
- Compare-and-delete is atomic (Lua), so a code cannot be consumed twice.
- Purpose-scoped keys prevent a `PHONE_CHANGE` code from being replayed against login.

### Weaknesses

- `/metrics` is unauthenticated by design (`src/routes/health/metrics.route.ts:11`) and relies on ingress restriction that the Helm chart does not configure.
- The OTP pepper defaults to a derivation of `JWT_REFRESH_SECRET` with no independent rotation story.
- `otp:att:` and `otp:lock:` are not purpose-scoped, so a `PHONE_CHANGE` attack can lock a victim out of `LOGIN`.
- `challengeId` is a raw uuid v7 (time-ordered), returned publicly.

---

## 16. Observability

**What exists:** a hand-rolled in-process Prometheus registry (`src/core/metrics/registry.ts`) exposed at `GET /metrics` in text exposition format v0.0.4.

**OTP counters actually emitted** (`src/modules/auth/metrics/otp.metrics.ts:36-38`, prefix `otp_`):

| Requested metric          | Status                                           | Emitted name                                                                         |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `otp.requested`           | **MISSING** (the event is published, no counter) | —                                                                                    |
| `otp.generated`           | **MISSING**                                      | —                                                                                    |
| `otp.queued`              | **MISSING** (no queue)                           | —                                                                                    |
| `otp.sent`                | ✅                                               | `otp_sent{provider}`                                                                 |
| `otp.failed`              | ✅                                               | `otp_failed{purpose}` (verify failure) + `otp_provider_failure{provider}` (delivery) |
| `otp.retry`               | **MISSING** (no retry)                           | —                                                                                    |
| `otp.delivered`           | **MISSING** (no DLR)                             | —                                                                                    |
| `otp.expired`             | ✅                                               | `otp_expired{purpose}`                                                               |
| `otp.verified`            | ✅                                               | `otp_success{purpose}`                                                               |
| `otp.verification_failed` | ✅                                               | `otp_failed{purpose}`                                                                |
| `otp.rate_limited`        | ✅                                               | `otp_rate_limited{purpose}`                                                          |
| —                         | ✅ extra                                         | `otp_locked{purpose}`                                                                |

**Label filtering:** only keys in `SAFE_LABELS` (`registry.ts:1-16`) survive. `latencyMs` is passed to `otpMetrics.sent()` (`otp.service.ts:137`) and then **silently discarded** — there is no histogram or summary type in the registry, so provider latency is unmeasurable.

**Vendor tooling:**

| System        | Present?                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Prometheus    | Only the exposition endpoint. `observability/prometheus/` is **empty** |
| Grafana       | `observability/grafana/dashboards/` is **empty**                       |
| Alerts        | `observability/alerts/` is **empty**                                   |
| Loki          | `observability/loki/` is **empty**                                     |
| OpenTelemetry | **Absent** — no package, no code                                       |
| Sentry        | **Absent**                                                             |
| Datadog       | **Absent**                                                             |

**Practical consequence:** metrics are per-pod, in-memory, and reset on restart. With `replicaCount: 3` and HPA to 20 (`values-production.yaml:3, 23`), OTP counters are meaningless without a scrape config that does not exist. **No alert fires when SMS delivery starts failing.**

---

## 17. Tests

**Unit** (`tests/unit/auth/`):

| File                         | Covers                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otp-generator.test.ts`      | Length, digits-only, **leading zeros**, uniqueness across 100 draws, configurable length                                                                                   |
| `otp-hasher.test.ts`         | Determinism, 64-hex output, never plaintext, pepper-keyed, matches independent HMAC                                                                                        |
| `otp-validator.test.ts`      | Exact length, non-numeric, whitespace/newline anchoring, configurable length                                                                                               |
| `otp-service-verify.test.ts` | 15 cases: match/consume, lockout gate, expiry-not-counted, wrong code, lockout notification, four challenge-ownership rejections, no-oracle equivalence, closed reason set |

**Integration** (`tests/integration/`): `auth-login`, `auth-concurrency`, `auth-expiry`, `auth-security`, `auth-enumeration`, `auth-session-cap`, `auth-tokens`, `auth-devices`, `auth-device-integrity`, `auth-driver-gate`, `auth-roles`, `user-phone-change`.

**Test seam:** `tests/integration/helpers/harness.ts:12-18` monkeypatches `OtpGenerator.generate` to return the constant `123456`. The real SMS provider is never exercised — `MockProvider` is selected by `APP_ENV=test`.

### Coverage matrix

| Case                                    | Covered?                                     | Where                                                       |
| --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Correct OTP                             | ✅                                           | `auth-login.test.ts`                                        |
| Wrong OTP                               | ✅                                           | `otp-service-verify.test.ts:141`                            |
| Expired OTP                             | ✅                                           | `auth-expiry.test.ts:146`, `otp-service-verify.test.ts:126` |
| OTP reuse                               | ✅                                           | `auth-concurrency.test.ts`                                  |
| Multiple OTP requests                   | ✅ (rate-limit axes)                         | `auth-security.test.ts:130+`                                |
| Duplicate verify request                | ✅                                           | `auth-concurrency.test.ts`                                  |
| **SMS provider failure**                | ❌ **NOT COVERED**                           | —                                                           |
| **SMS timeout**                         | ❌ **NOT COVERED**                           | —                                                           |
| **SMS 429**                             | ❌ **NOT COVERED**                           | —                                                           |
| **SMS 500**                             | ❌ **NOT COVERED**                           | —                                                           |
| **Redis failure**                       | ❌ **NOT COVERED** for the OTP path          | —                                                           |
| **Queue failure**                       | ❌ N/A (no OTP queue)                        | —                                                           |
| **Worker failure**                      | ❌ **NOT COVERED**                           | —                                                           |
| **Retry**                               | ❌ N/A                                       | —                                                           |
| **Dead-letter**                         | ❌ N/A                                       | —                                                           |
| Rate limit                              | ✅ per axis                                  | `auth-security.test.ts`                                     |
| Lockout                                 | ✅                                           | `otp-service-verify.test.ts:154`                            |
| Concurrent verification                 | ✅                                           | `auth-concurrency.test.ts:86-95`                            |
| **Concurrent OTP requests (send race)** | ❌ **NOT COVERED**                           | —                                                           |
| **`OtpService.send` at all**            | ❌ **No unit test exists for the send path** | —                                                           |

**Summary of missing coverage:** every delivery-failure mode, the entire send path as a unit, the send-side concurrency race, and Redis unavailability.

---

## 18. Infrastructure

| Artifact             | State                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`         | 4-stage build, `dumb-init` entrypoint, non-root `node` user, `CMD ["node","dist/server.js"]`. **Single image, API only**                                                                                                                                  |
| `docker-compose.yml` | `api`, `postgres` (postgis 17-3.5), `redis` (8-trixie, `--appendonly yes`). **No worker** — comment at L2-3 states it is "intentionally absent until src/jobs/workers is implemented", which is now stale: the workers exist                              |
| Kubernetes / Helm    | `infrastructure/helm/templates/` = `configmap`, `deployment`, `hpa`, `ingress`, `pdb`, `service`, `serviceaccount`. **Exactly one Deployment. No worker workload, no CronJob**                                                                            |
| Terraform            | `infrastructure/terraform/` is **empty**                                                                                                                                                                                                                  |
| GitHub Actions       | `ci.yml` (lint/typecheck → tests with Postgres+Redis services → build + image smoke test), `production.yml` (build → `kubectl run` prisma migrate deploy → `helm upgrade --atomic` → health check), plus `staging`, `release`, `security`, `prisma-check` |
| Production env       | `values-production.yaml`: 3 replicas, HPA 3→20, PDB minAvailable 2, 60s termination grace, secrets from `existingSecret: zaroorat-backend-secrets`                                                                                                        |

**How each component runs today:**

| Component          | Deployment                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| API                | Helm Deployment, 3–20 replicas                                                        |
| Redis              | **External / unmanaged** — only `REDIS_URL` is consumed. Not in the chart             |
| PostgreSQL         | **External / unmanaged** — only `DATABASE_URL`. Migrations via one-shot `kubectl run` |
| **BullMQ workers** | **NOT DEPLOYED.** `npm run worker` exists; nothing invokes it                         |
| SMS                | Outbound HTTPS from the API pods; no egress policy, no secret wired in the chart      |

**Are API and worker processes separated?** In _code_, yes — cleanly (`src/server.ts` vs `src/worker.ts`, separate bootstraps, separate shutdown paths). In _deployment_, **no** — the worker is never started, so no scheduled job in the entire system runs in production.

---

## 19. Failure Scenarios

### The requested scenario: customer requests OTP → OTP generated → SMS provider fails

Traced from `src/modules/auth/services/otp/otp.service.ts:90-154`:

| #   | Question                               | Answer                                                                                                                                                                             | Evidence                                                                                             |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Does the API return failure?           | **No — HTTP 200** with a valid `challengeId`                                                                                                                                       | `otp.service.ts:150-154`; the `!delivery.accepted` branch at L130 only logs and increments a counter |
| 2   | Is the OTP still stored?               | **Yes** — written to Redis at L92, _before_ the SMS attempt at L104. Full 300s TTL                                                                                                 | `OtpStore.store`, L29-31                                                                             |
| 3   | Does the customer receive another OTP? | **No.** Nothing else is sent                                                                                                                                                       | —                                                                                                    |
| 4   | Automatic retry?                       | **No**                                                                                                                                                                             | §10                                                                                                  |
| 5   | Sync or async retry?                   | Neither exists                                                                                                                                                                     | —                                                                                                    |
| 6   | Is another OTP generated?              | Not automatically. Only on a new client request **after** the 60s cooldown key expires                                                                                             | `otp.service.ts:71-78`                                                                               |
| 7   | Is the same OTP reused?                | **Effectively yes for 60s**: any resend inside the cooldown returns the _same_ `challengeId` and does **not** re-attempt delivery — the undelivered code stays live and unsendable | `otp.service.ts:71-78`                                                                               |
| 8   | Does the OTP expire?                   | Yes, silently after 300s. No `expired` outcome is written for an un-attempted challenge                                                                                            | `OtpStore.ts:30`                                                                                     |
| 9   | Can the customer request another?      | Only after 60s, and **each attempt burns one of 3 per-phone slots per hour**                                                                                                       | `otp.config.ts:20-24`                                                                                |
| 10  | After repeated failures?               | **3 failed sends in an hour → HTTP 429 `RATE_LIMITED` with `Retry-After` up to 3600s.** The customer is locked out of the product by the provider's outage                         | `otp.rate-limiter.ts:29-30`; `otp.service.ts:85-88`                                                  |

**Audit trail during the outage:** a row _is_ written with `outcome: 'sent'` and `failureReason` set (`otp.service.ts:110, 120`) — so `outcome` says `sent` even when nothing was sent. Forensics will read this incorrectly.

### Other failure modes traced

| Scenario                                   | Current behavior                                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MSG91 hangs**                            | The HTTP request hangs with it. No `AbortSignal` (`msg91.provider.ts:36`). The Fastify connection, an Awilix scope, and a Redis-backed OTP are all held open. Under load this exhausts the pod                                           |
| **MSG91 returns 429**                      | Treated identically to a 400 — `accepted: false`, no backoff, no circuit break (`msg91.provider.ts:49`)                                                                                                                                  |
| **MSG91 returns 5xx**                      | Identical to 429 — no distinction between retryable and permanent                                                                                                                                                                        |
| **Redis down**                             | The `rateLimit` preHandler fails closed → 503 (`rate-limit.plugin.ts:82-92`). If it were bypassed, `OtpService` throws into the generic 500 handler. **Authentication is fully unavailable**                                             |
| **Postgres down**                          | The OTP is already in Redis, but `otpRepository.create` throws at L107 → 500, _after_ the SMS was sent. The customer receives a code they cannot use: no `challengeId` is returned, and the challenge key is never set                   |
| **Two concurrent sends, same phone**       | Both pass the `getChallenge` check at L71 (read-then-write, no lock), both generate, the second `SET` overwrites the first, **both SMS are sent**, two audit rows are created. The customer receives two codes and only the second works |
| **Verify with a superseded `challengeId`** | Succeeds. `assertChallengeBelongsToCaller` only checks phone/purpose/`verifiedAt`; the code is matched against whatever is currently in Redis. The stale row is marked `verified`                                                        |
| **`SMS_PROVIDER=mock` in production**      | Every OTP is "accepted", nothing is delivered, `otp_sent{provider="mock"}` looks healthy. No guard exists (`notification.config.ts:17`)                                                                                                  |

---

## 20. Production Risks

Format: **Problem · Evidence · File · Function · Current behavior · Production risk · Recommended solution** (recommendations are proposals only — nothing was implemented).

### CRITICAL

**C-1 — SMS provider is called synchronously in the HTTP request path, with no timeout**

- **Evidence:** `await this.notificationService.sendOtp(phoneNumber, code)` inside the handler; `fetch()` with no `signal`.
- **File:** `src/modules/auth/services/otp/otp.service.ts:104` → `src/modules/notifications/providers/msg91.provider.ts:36`
- **Function:** `OtpService.send` → `Msg91Provider.sendSms`
- **Current behavior:** every login blocks on a third-party HTTPS round trip that can never time out.
- **Risk:** MSG91 latency is login latency. An MSG91 hang holds Fastify connections open until the client gives up; with 3–20 pods and a 3600s ingress read timeout, a provider stall cascades into a full authentication outage. This is the single largest availability risk in the system.
- **Recommended:** move delivery to a BullMQ job; return as soon as the OTP is in Redis. Whatever remains synchronous must carry an `AbortSignal.timeout(...)`.

**C-2 — Delivery failure is reported to the customer as success**

- **Evidence:** the `!delivery.accepted` branch logs a warning and falls through to the same 200 response.
- **File:** `src/modules/auth/services/otp/otp.service.ts:130-154`
- **Function:** `OtpService.send`
- **Current behavior:** HTTP 200 + `challengeId` + `expiresInSec: 300`, with no SMS sent and no retry.
- **Risk:** the customer stares at a code entry screen for a code that will never arrive; support has no signal; the audit row says `outcome: 'sent'`. Three occurrences in an hour and the per-phone limit locks them out for up to an hour (C-2 × §11).
- **Recommended:** with a queue in place, a 200 becomes honest ("accepted for delivery"), and a terminal delivery failure must produce a distinct outcome, a metric, an alert, and must not consume the customer's per-phone budget.

**C-3 — The BullMQ worker process is not deployed in any environment**

- **Evidence:** `docker-compose.yml:2-3` declares the worker "intentionally absent"; `infrastructure/helm/templates/` contains a single `deployment.yaml` with no worker workload; `production.yml` deploys only that chart.
- **File:** `docker-compose.yml`, `infrastructure/helm/templates/deployment.yaml`
- **Function:** `startWorker` (`src/bootstrap/worker.bootstrap.ts:16`) — never invoked in production
- **Current behavior:** all nine scheduled jobs, including `auth-retention`, never execute.
- **Risk:** `otp_verifications` and `refresh_tokens` grow without bound (a PII-retention exposure as well as a storage one); ride dispatch timeouts, request expiry, driver heartbeat timeout, and payment reconciliation silently never run. Any OTP queue added now would have no consumer.
- **Recommended:** a second Deployment (`command: ["node","dist/worker.js"]`) from the same image, plus a compose service, before any queue work lands.

**C-4 — Full phone numbers are written to logs; OTP codes are logged in development**

- **Evidence:** `logger.error({ to: message.to, ... })`; `logger.debug({ to, body, variables })` where `body`/`variables` contain the code; `REDACT_PATHS` covers neither `to` nor `body`.
- **File:** `src/modules/notifications/providers/msg91.provider.ts:51, 62`; `src/modules/notifications/providers/mock.provider.ts:10-14`; `src/shared/logger/redact.ts:1-9`
- **Function:** `Msg91Provider.sendSms`, `MockProvider.sendSms`
- **Current behavior:** every provider error logs an unmasked E.164 number at `error` level in production. In development (`logger.level = 'debug'`), the OTP itself is logged.
- **Risk:** PII in log aggregation, breach blast-radius, and a plaintext-OTP trail in any environment running at debug. `maskPhone` already exists and is simply not wired in.
- **Recommended:** add `to`, `phoneNumber`, `phone`, `mobiles`, `code`, `otp`, `body`, `variables` to `REDACT_PATHS`; apply `maskPhone` at both provider call sites; never log message bodies.

### HIGH

**H-1 — No timeout, no retry, and no status differentiation on the provider call**

- **Evidence:** `msg91.provider.ts:36-53` — one `fetch`, `!res.ok || type === 'error'` collapses 400/401/429/500/503 into one outcome.
- **Risk:** a retryable 429 or 503 is discarded as permanently as a malformed template. No backoff means that when MSG91 recovers, nothing re-drives the backlog.
- **Recommended:** classify by status (`429`/`5xx`/network → retryable; `4xx` → terminal) and let the queue's backoff policy act on that classification.

**H-2 — Send is a read-then-write race with no lock**

- **Evidence:** `getChallenge` at `otp.service.ts:71`, `store` at L92, `setChallenge` at L123 — three separate round trips with no `SET NX` and no `LockStore` use.
- **Function:** `OtpService.send`
- **Current behavior:** concurrent sends for one phone both generate, both send SMS, and the second overwrites the first.
- **Risk:** duplicate SMS spend, a customer holding two codes of which only one works, and a bypass of the intended 60s cooldown. `LockStore.acquire` and the unused `RateLimitStore.enforceMinInterval` are both already available.
- **Recommended:** claim the cooldown with `SET NX` _before_ generating, not after delivery.

**H-3 — The idempotency keyspace is not namespaced**

- **Evidence:** `idempotency: (key) => \`idem:${key}\`` — no route, user, or body component.
- **File:** `src/core/cache/keys.ts:13`; `src/core/cache/stores/IdempotencyStore.ts:36`
- **Current behavior:** one flat namespace shared by `/otp/verify`, `/token/refresh`, and phone-change verify, TTL 24h.
- **Risk:** a client reusing a UUID across endpoints receives another endpoint's cached response — a token pair where a phone-change result was expected, or vice versa. Cross-user collision is possible if any client derives keys deterministically.
- **Recommended:** namespace by route + authenticated subject, and bind the record to a request-body hash.

**H-4 — `POST /otp/send` has no idempotency control**

- **Evidence:** no `Idempotency-Key` in the route schema (`auth.routes.ts:27-49`) or the controller (`auth.controller.ts:63-84`).
- **Risk:** a mobile client retrying on a flaky network burns per-phone quota and, once a queue exists, will enqueue duplicate delivery jobs.
- **Recommended:** accept an optional key on send and use it as the queue's `jobId`.

**H-5 — `SMS_PROVIDER=mock` silently disables all delivery in production**

- **Evidence:** `const smsProvider = explicit ?? (env === 'production' ... )` — the explicit value always wins.
- **File:** `src/modules/notifications/notification.config.ts:17`
- **Risk:** a stray env var makes every login "succeed" with zero SMS delivered, and the metrics look healthy. Compounded by the fact that no MSG91 variable appears in `.env.example`, `.env.production`, or the Helm values, so a first production deploy fails at boot (`notification.config.ts:35`) or, worse, does not.
- **Recommended:** refuse `mock` when `APP_ENV` is production/staging; document every MSG91 variable and wire them into the chart's secret.

**H-6 — No global or provider-level rate ceiling**

- **Evidence:** `otp.config.ts:19-35` defines phone/device/IP axes only. No system-wide counter exists anywhere.
- **Risk:** a distributed attacker rotating phone numbers and source IPs is bounded only per-key. There is no cap on total SMS spend and no circuit breaker when MSG91 starts failing — the system keeps hammering a failing provider at full rate.
- **Recommended:** a global per-minute token bucket plus a provider circuit breaker, both trivially expressible with the existing `RateLimitStore`.

**H-7 — Lockout and attempt counters are not purpose-scoped**

- **Evidence:** `otpAttempts: (phone) => \`otp:att:${phone}\``and`otpLock: (phone)`take no`purpose`, unlike `otp:`and`otp:challenge:`.
- **File:** `src/core/cache/keys.ts:3-4`
- **Risk:** failed `PHONE_CHANGE` verifications lock the victim out of `LOGIN` for 900s — a denial-of-service against any account whose number is known, reachable through an authenticated attacker's own phone-change flow.
- **Recommended:** scope both keys by purpose, as the secret and challenge keys already are.

### MEDIUM

**M-1 — Verify does not bind the code to the presented `challengeId`.** `assertChallengeBelongsToCaller` (`otp.service.ts:202-230`) checks phone, purpose, and `verifiedAt`, but the code is compared against whatever currently sits in `otp:{purpose}:{phone}`. A superseded challenge row gets marked `verified`, corrupting the audit trail.

**M-2 — `outcome: 'sent'` is written even when delivery was rejected.** `otp.service.ts:110` hardcodes `'sent'`; only `failureReason` distinguishes the two (L120). Delivery-success rate cannot be computed from the table.

**M-3 — The `attempts` column is never written.** Declared at `auth.prisma:60`, no write path exists. Attempt counts live only in Redis and vanish with the TTL, so post-incident forensics cannot reconstruct them.

**M-4 — Verify code length is hardcoded in the schema.** `verifyOtpSchema` uses `/^\d{6}$/` (`auth.schemas.ts:29`) while `OtpValidator` reads `otpConfig.codeLength` (`otp.validator.ts:7`). Setting `OTP_CODE_LENGTH=4` makes every verify fail at the schema layer.

**M-5 — One Redis connection per queue _and_ per worker.** `createQueueConnection()` (`queues/index.ts:33`) is called fresh in `maintenanceQueue` and again in `startMaintenanceWorker`. Six queues + six workers = 12 connections per worker pod, plus the shared client. An OTP queue would add more.

**M-6 — Provider latency is measured and thrown away.** `latencyMs` is computed (`otp.service.ts:103-105`), passed to the metric (L137), and dropped because it is not in `SAFE_LABELS` and the registry has no histogram type (`registry.ts:1-16, 66-72`).

**M-7 — Observability directories are empty.** `observability/{alerts,grafana,prometheus,loki}/` contain nothing, and no scrape config targets `/metrics`. Nothing alerts on an SMS outage.

**M-8 — No delivery-receipt (DLR) webhook.** `providerRef` is captured (`msg91.provider.ts:58`) but never reconciled. "Accepted by MSG91" is recorded as if it were "delivered to the handset".

**M-9 — Redis is a single unmanaged instance with no failover configuration.** `client.ts:9` takes one URL; the Helm chart does not deploy or reference Redis at all. Redis is a hard dependency of authentication (§7).

### LOW

**L-1 — Dead code:** `RateLimitStore.enforceMinInterval` (`RateLimitStore.ts:46-56`) and `OtpRepository.countByPhoneSince` (`otp.repository.ts:73-77`) have no call sites.

**L-2 — Stale comment:** `docker-compose.yml:2-3` says the worker is absent "until `src/jobs/workers` is implemented" — it has been implemented.

**L-3 — Undocumented environment variables:** none of `OTP_*`, `SMS_PROVIDER`, `MSG91_*`, `RL_OTP_*` appear in `.env.example`.

**L-4 — `OtpPurpose.REGISTER` is defined** (`auth.enums.prisma:3`) but never used — `AUTH_OTP_PURPOSE` is always `'LOGIN'` (`auth.constants.ts:1`).

**L-5 — `deviceId` is dropped from the audit row unless it is a UUID** (`otp.service.ts:27-29, 115`), while the schema accepts any 1–128-char string (`auth.schemas.ts:11`). Fraud investigation loses the identifier the rate limiter actually used.

**L-6 — `/metrics` is unauthenticated** (`metrics.route.ts:11`) and the documented ingress restriction is not present in the Helm chart.

---

## 21. Recommended Architecture

Proposal only — **not implemented**, and deliberately built from what this repository already has rather than from any other company's design.

```
POST /api/v1/auth/otp/send
   │
   ├─ rate limit (unchanged: phone / device / IP)          ← existing OtpRateLimiter
   ├─ SET NX cooldown claim                                ← existing LockStore / enforceMinInterval
   ├─ generate + HMAC + SET EX 300                         ← existing OtpGenerator / OtpHasher / OtpStore
   ├─ INSERT audit row  outcome = 'queued'                 ← existing OtpRepository
   ├─ queue.add('otp-delivery', {...}, { jobId })          ← NEW producer
   └─ 202 { challengeId, expiresInSec, resendAvailableInSec }
                        │
                        ▼
              otp-delivery queue  (BullMQ, existing infra)
                 attempts: 3
                 backoff: exponential, 2s base, jittered
                 removeOnComplete: { age: 3600 }
                 removeOnFail: false → DLQ
                        │
                        ▼
              OTP worker (concurrency ~20)
                 ├─ AbortSignal.timeout(5000) on the provider call
                 ├─ classify: 429/5xx/network → throw (retry);  4xx → terminal
                 ├─ success  → outcome 'sent',   otp_sent,      auth.otp.sent
                 ├─ terminal → outcome 'failed', otp_failed,    refund the phone quota
                 └─ exhausted→ DLQ + alert
```

**What must be preserved as-is:** the generator, the hasher, the Lua compare-and-delete, purpose-scoped keys, the no-secret-in-Postgres rule, the enumeration-safe response shape, and the expiry-does-not-count-toward-lockout behavior. All of it is correct and tested.

**What changes:**

| Concern          | Today                   | Proposed                                                            |
| ---------------- | ----------------------- | ------------------------------------------------------------------- |
| Delivery         | Inline `await`          | BullMQ job, API returns immediately                                 |
| Response code    | 200 "sent"              | 202 "accepted for delivery"                                         |
| Timeout          | None                    | `AbortSignal.timeout` on the provider call                          |
| Retry            | None                    | 3 attempts, exponential + jitter, only for retryable classes        |
| Terminal failure | Silent                  | DLQ + alert + quota refund + distinct outcome                       |
| Cooldown claim   | After delivery          | `SET NX` before generation (closes H-2)                             |
| Idempotency      | Send: none              | Optional key → BullMQ `jobId`                                       |
| Purpose scoping  | Secret + challenge only | Extend to attempts + lock (closes H-7)                              |
| Global ceiling   | None                    | Token bucket + provider circuit breaker                             |
| Logging          | Phone in plaintext      | Masked at every call site                                           |
| Metrics          | 7 counters              | Add `queued`, `retry`, `dlq`, `delivered`, plus a latency histogram |
| Worker           | Undeployed              | Second Deployment from the same image                               |

**Open design decision:** whether the OTP queue reuses `auth-maintenance` or gets a dedicated `auth-otp` queue with its own worker and concurrency. Recommendation: dedicated — a cron purge at concurrency 1 and interactive delivery at concurrency 20 must not share a worker's head-of-line.

---

## 22. Recommended Implementation Plan

Sequenced so each phase is independently shippable and reversible. **None of this has been started.**

| Phase | Work                                                                                                                                 | Risk     | Unblocks                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------- |
| **0** | Deploy the worker (Helm Deployment + compose service). No code change                                                                | Low      | Everything; also fixes C-3 and restarts the retention purge |
| **1** | Redaction + `maskPhone` at provider call sites; document and wire `MSG91_*` / `SMS_PROVIDER`; refuse `mock` in prod                  | Low      | C-4, H-5                                                    |
| **2** | `AbortSignal.timeout` + status classification in `Msg91Provider` — still synchronous                                                 | Low      | H-1; bounds C-1 immediately                                 |
| **3** | `otp-delivery` queue, producer, worker, retry/backoff, DLQ. `OtpService.send` enqueues instead of awaiting; `outcome` gains `queued` | **High** | C-1, C-2                                                    |
| **4** | Move the cooldown claim to `SET NX` before generation; purpose-scope attempt/lock keys                                               | Medium   | H-2, H-7                                                    |
| **5** | Namespace the idempotency keyspace; accept an optional key on send                                                                   | Medium   | H-3, H-4                                                    |
| **6** | Global token bucket + provider circuit breaker                                                                                       | Medium   | H-6                                                         |
| **7** | Latency histogram, `otp_queued` / `otp_retry` / `otp_dlq` counters, Prometheus scrape config, alert rules                            | Low      | M-6, M-7                                                    |
| **8** | MSG91 DLR webhook → `otp_delivered`, reconciled via `providerRef`                                                                    | Medium   | M-8                                                         |
| **9** | Backfill tests: provider failure/timeout/429/500, send-path unit tests, send-race concurrency, Redis-down                            | Low      | §17 gaps                                                    |

Phase 3 is the only one that changes the public API contract (200 → 202, and "sent" becomes "accepted"). Mobile clients must be checked before it ships.

---

## 23. Files That Would Need Modification

Listed for planning. **No file below was touched during this audit.**

**Core changes**

- `src/modules/auth/services/otp/otp.service.ts` — enqueue instead of await; cooldown claim before generation
- `src/jobs/producers/index.ts` — currently `export {}`; would hold the OTP producer
- `src/jobs/consumers/index.ts` — currently `export {}`; would hold the delivery consumer
- `src/jobs/queues/index.ts` — new queue name, new job name, per-queue job options
- `src/jobs/workers/index.ts` — the generic handler assumes `MaintenanceRunner.run(now)`; an OTP job carries a payload and needs a distinct worker
- `src/modules/notifications/providers/msg91.provider.ts` — timeout, status classification, masked logging
- `src/modules/notifications/notification.config.ts` — refuse `mock` in production

**Supporting changes**

- `src/core/cache/keys.ts` — purpose-scope `otpAttempts` / `otpLock`; namespace `idempotency`
- `src/core/cache/stores/IdempotencyStore.ts` — namespaced keys
- `src/core/cache/stores/OtpStore.ts` — `SET NX` cooldown claim
- `src/config/otp/otp.config.ts` — queue/retry/timeout tunables
- `src/modules/auth/repositories/otp.repository.ts` — `queued` outcome, `attempts` writes
- `src/modules/auth/metrics/otp.metrics.ts` — new counters
- `src/core/metrics/registry.ts` — histogram support for latency
- `src/shared/logger/redact.ts` — phone/code/body paths
- `src/modules/auth/schemas/auth.schemas.ts` — code length from config (M-4)
- `src/modules/auth/schemas/auth.responses.ts` + `routes/auth.routes.ts` — 202 contract
- `src/bootstrap/worker.bootstrap.ts` — register the OTP worker

**Schema**

- `prisma/schema/modules/auth/auth.prisma` — `outcome` values; possibly `deliveredAt`, `attemptCount`
- One migration

**Infrastructure**

- `infrastructure/helm/templates/` — new worker Deployment (+ optionally its own HPA/PDB)
- `infrastructure/helm/values*.yaml` — worker block, MSG91 secret keys
- `docker-compose.yml` — worker service
- `.env.example`, `.env.production` — all `OTP_*`, `SMS_PROVIDER`, `MSG91_*`, `RL_OTP_*`
- `observability/prometheus/`, `observability/alerts/`, `observability/grafana/dashboards/` — currently empty

**Tests**

- New: `tests/unit/auth/otp-service-send.test.ts`, `tests/unit/notifications/msg91-provider.test.ts`, `tests/integration/otp-delivery-queue.test.ts`
- Modified: `tests/integration/helpers/harness.ts` (must drain the queue, or run the worker inline)
- Modified: every `auth-*.test.ts` that asserts `statusCode === 200` on send

---

## 24. Open Questions

1. **Contract change.** Is 200 → 202 on `/otp/send` acceptable, and are the mobile clients tolerant of it? If not, the API must keep returning 200 with a semantics change documented instead.
2. **Quota accounting on delivery failure.** When a job exhausts its retries, should the customer's per-phone slot be refunded? Not refunding means a provider outage locks customers out (today's behavior). Refunding opens a quota-bypass path if failures can be induced.
3. **Cooldown vs. delivery.** Should the 60s cooldown start when the job is _enqueued_ or when delivery _succeeds_? Starting on enqueue means a customer waits 60s for an SMS that already failed.
4. **Per-phone limit of 3/hour.** Is this deliberate? It is aggressive for a ride-hailing login where a customer may switch devices mid-trip, and it is the mechanism that turns an SMS outage into a lockout.
5. **Queue placement.** Dedicated `auth-otp` queue, or reuse `auth-maintenance`? (Recommendation in §21: dedicated.)
6. **Fallback provider.** Is a second SMS provider planned? If so, the `SmsProvider` interface (`providers/sms.provider.ts:15-19`) supports it cleanly and the failover belongs in the worker, not the provider.
7. **DLR webhooks.** Is the MSG91 account provisioned for delivery receipts? Without them, `otp.delivered` cannot be implemented at all.
8. **Redis topology.** Is production Redis managed (ElastiCache/Memorystore) with failover? Authentication is fully unavailable without it, and the chart carries no configuration.
9. **OTP pepper rotation.** Should `OTP_PEPPER` be set explicitly in production rather than derived from `JWT_REFRESH_SECRET` (`otp.config.ts:4-10`)? Today, rotating the JWT secret silently invalidates every in-flight OTP.
10. **Ride OTP convergence.** `RideOtp` stores its hash in Postgres and shares `OtpHasher` with auth. Should the two systems stay independent? The pepper coupling is an undocumented shared dependency.
11. **Worker scaling signal.** HPA on CPU is wrong for a queue worker. Is a KEDA-style queue-depth scaler available in the cluster?
12. **`OtpPurpose.REGISTER`.** Dead enum value — is a distinct registration flow still planned, or should it be dropped?

---

_End of audit. Discovery only — no code was modified. Next phase: design the production OTP delivery architecture from these findings._
