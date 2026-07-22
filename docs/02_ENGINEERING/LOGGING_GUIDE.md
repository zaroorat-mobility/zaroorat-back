# Logging

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [Monitoring](../03_OPERATIONS/MONITORING.md), `config/logger.ts`

Logs are for the person debugging at 3 a.m. Make them structured, correlated, and safe.

---

## 1. Rules

- **No `console.log`.** Use the structured logger (`config/logger.ts`). Lint blocks `console.*`.
- **Structured JSON** — every log line is an object with fields, not an interpolated sentence.
- **Every log carries `requestId`** (and trace/span ids) so a request can be followed across API → queue → worker ([request-id middleware](../01_ARCHITECTURE/SYSTEM_ARCHITECTURE.md)).
- **Never log secrets or PII** — no tokens, OTP codes, full phone numbers, card data, or precise user coordinates. Redact/mask.

## 2. Levels

| Level   | Use                                                                                |
| ------- | ---------------------------------------------------------------------------------- |
| `error` | a request/job failed in a way that needs attention; include error + context        |
| `warn`  | recovered or degraded (retry, fallback channel, expiring doc)                      |
| `info`  | significant business events (trip state change, payment captured, driver verified) |
| `debug` | developer detail; off in production by default                                     |
| `trace` | very verbose; local only                                                           |

## 3. What to log

- **Do:** request start/end with method, route, status, duration, `requestId`, userId (opaque), outcome.
- **Do:** state transitions (`trip.state_changed`), money events, worker job start/finish/retry/dead-letter.
- **Don't:** log inside tight loops, log full request/response bodies, or log the same error at every layer (log once, at the boundary).

## 4. Correlation

- `requestId` is generated at the edge and propagated into enqueued jobs, so a worker log line links back to the API call that spawned it.
- Prefer one structured error log at `middleware/error.ts` over re-logging as the error bubbles up.

## 5. Standard fields

```json
{
  "level": "info",
  "time": "2026-07-20T10:00:00.000Z",
  "requestId": "req_...",
  "userId": "usr_...",
  "module": "rides",
  "event": "trip.state_changed",
  "tripId": "trp_...",
  "from": "MATCHING",
  "to": "DRIVER_ASSIGNED",
  "durationMs": 42
}
```

## 6. Retention & shipping

- Logs ship to the central stack in `observability/`.
- Retention follows policy; PII must not persist in logs beyond what policy allows.
- Metrics and traces complement logs — see [Monitoring](../03_OPERATIONS/MONITORING.md).
