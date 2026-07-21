# Workflows — End-to-End Flows

> **Project:** Zaroorat — Ride-Hailing Platform
> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **Answers:** *How do the key journeys actually run, step by step?*
> **Traces from:** [LLD](./ER_DIAGRAM.md), [HLD](./SYSTEM_ARCHITECTURE.md)

These sequence diagrams show the runtime behavior of the critical journeys. Participants map to modules/processes in the codebase.

---

## 1. Authentication (OTP login) — FR-AUTH

```mermaid
sequenceDiagram
    participant App as Rider/Driver App
    participant API
    participant Auth as auth service
    participant SMS as SMS provider
    participant DB as Postgres

    App->>API: POST /auth/otp/request { phone }
    API->>Auth: requestOtp(phone)
    Auth->>DB: store OtpChallenge (codeHash, expiresAt) [rate-limited]
    Auth->>SMS: send code
    API-->>App: 202 Accepted
    App->>API: POST /auth/otp/verify { phone, code }
    API->>Auth: verifyOtp(phone, code)
    Auth->>DB: check code, attempts, expiry → consume
    Auth-->>API: issue accessToken + refreshToken
    API-->>App: 200 { tokens, user, roles }
```
**Failure paths:** too many requests → `429`; wrong/expired code → `401` + attempt counter; exhausted attempts → challenge locked.

---

## 2. Driver onboarding & verification — FR-ONBOARD

```mermaid
sequenceDiagram
    participant D as Driver App
    participant API
    participant OB as onboarding
    participant Files as files
    participant Store as Object Storage
    participant Docs as documents
    participant Ops as Ops/Admin
    participant DB as Postgres

    D->>API: POST /files/upload-url { contentType }
    API->>Files: signedUploadUrl()
    Files->>Store: create signed PUT
    API-->>D: { uploadUrl, fileRef }
    D->>Store: PUT file (direct)
    D->>API: POST /documents { type, fileRef, expiresAt }
    API->>Docs: submit → status UNDER_REVIEW
    Docs->>DB: insert Document
    Ops->>API: POST /admin/documents/:id/review { decision, reason }
    API->>Docs: review → APPROVED / REJECTED
    Docs->>OB: recompute onboarding status
    OB->>DB: driver.isOperable = (all docs APPROVED & valid && vehicle APPROVED)
    OB-->>D: notify status change
```
**Invariant:** driver cannot go online until `isOperable` is true (LLD §2.2).

---

## 3. Core loop — request → match → dispatch → ride → pay (the money shot)

```mermaid
sequenceDiagram
    participant R as Rider App
    participant API
    participant Pricing as pricing
    participant Rides as rides (state machine)
    participant Match as matching
    participant Disp as dispatch
    participant W as rides.worker
    participant D as Driver App
    participant Pay as payments
    participant PW as payments.worker
    participant DB as Postgres

    R->>API: POST /rides/estimate
    API->>Pricing: estimate(distance,category,surge,promo)
    API-->>R: { fareEstimate, eta }

    R->>API: POST /rides (Idempotency-Key)
    API->>Rides: create trip → REQUESTED → MATCHING
    Rides->>Match: buildCandidates(pickup, category)
    Match-->>Disp: ordered candidates
    Disp->>D: offer trip (countdown)
    Disp->>W: schedule dispatch-timeout job

    alt driver accepts in time
        D->>API: POST /dispatch/offers/:id/accept (Idem-Key)
        API->>Rides: MATCHING → DRIVER_ASSIGNED (lock driver)
        W-->>W: timeout job no-ops (state advanced)
        Rides-->>R: trip:state DRIVER_ASSIGNED (socket)
    else timeout / decline
        W->>Disp: offer next candidate
        Note over Disp,W: repeat until accept or candidates exhausted → NO_DRIVERS
    end

    D->>API: POST /rides/:id/arrived → ARRIVED
    D->>API: POST /rides/:id/start { otp } → IN_PROGRESS
    Note over R,D: live location + chat over sockets
    D->>API: POST /rides/:id/complete → COMPLETED
    Rides->>Pricing: finalize fare (actuals)
    Rides->>Pay: emit trip.completed
    Pay->>PW: enqueue charge (Idem-Key)
    PW->>DB: create Payment (unique idemKey) + LedgerEntry
    PW->>Rides: payment.captured → COMPLETED → PAID
    Rides-->>R: trip:state PAID + fare breakdown
```

**Key guarantees shown:**
- The **worker owns the dispatch timeout** — the flow never depends on a client timer.
- **Idempotency-Key** on `POST /rides`, accept, and charge — retries on flaky mobile networks are safe.
- **State machine** advances only forward; a late accept after re-assignment is rejected.
- **Payment is transactional + idempotent** — `Payment.idempotencyKey` unique constraint is the backstop.

---

## 4. Cancellation — FR-DISPATCH

```mermaid
sequenceDiagram
    participant P as Rider or Driver
    participant API
    participant Rides as rides
    participant Pricing as pricing
    participant Disp as dispatch
    participant DB as Postgres

    P->>API: POST /rides/:id/cancel { reason }
    API->>Rides: validate transition (current state → CANCELLED)
    alt within grace window
        Rides->>DB: state → CANCELLED, fee = 0
    else past grace / driver en route
        Rides->>Pricing: computeCancellationFee(policy, market)
        Rides->>DB: state → CANCELLED, record fee
    end
    Rides->>Disp: free the driver (unlock, available for matching)
    Rides-->>P: { status: CANCELLED, fee }
```
Policy (grace window, fee amount) comes from `settings` per market — open question in PRD §5.

---

## 5. Real-time location & trip state — FR-GEO

```mermaid
sequenceDiagram
    participant D as Driver App
    participant WS as Socket.io (API instance)
    participant Redis as Redis (adapter + geo)
    participant R as Rider App
    participant DB as Postgres

    D->>WS: location:update { lat,lng,at } (rate-bounded)
    WS->>Redis: update presence/geo (TTL)
    Note over WS: only active-trip rider gets driver position
    WS->>R: trip:driver_location { lat,lng } (via trip room)
    Note over WS,DB: trip state transitions persisted to DB, then pushed
    DB-->>WS: state changed
    WS->>R: trip:state { status }
    WS->>D: trip:state { status }
```
On reconnect, clients call `GET /rides/:id` to reconcile with server-authoritative state (HLD §6).

---

## 6. Payment & payout / cash reconciliation — FR-PAYMENTS

```mermaid
sequenceDiagram
    participant PW as payments.worker
    participant Gate as Payment Gateway
    participant DB as Postgres
    participant Fin as Finance/Ops

    Note over PW: on trip.completed
    alt digital
        PW->>Gate: capture(amount, idemKey)
        Gate-->>PW: success/failure
        PW->>DB: Payment + LedgerEntry (rider debit, driver credit, platform commission)
    else cash
        PW->>DB: Payment(method=cash) + LedgerEntry (driver owes commission)
    end
    PW->>DB: trip → PAID
    Note over PW,Fin: scheduled payout job batches driver credits
    PW->>Gate: payout(driver, net) [retryable]
    Fin->>DB: reconcile cash balances / disputes
```
Retries use the same idempotency key; a transient gateway failure never double-charges (LLD §4.4, §7).

---

## 7. SOS / safety — FR-SOS

```mermaid
sequenceDiagram
    participant U as Rider/Driver (in trip)
    participant WS as Socket.io
    participant SOS as sos
    participant Sup as support/admin
    participant Notif as notifications
    participant DB as Postgres

    U->>WS: sos:trigger { tripId }   (never rate-limited)
    WS->>SOS: record SosEvent + location snapshot
    SOS->>DB: insert SosEvent (full context)
    SOS->>Sup: escalate (alert ops/support)
    SOS->>Notif: notify emergency contacts / trip-share recipients
    SOS-->>U: acknowledged
```
**Invariant:** SOS works in every active-trip state and cannot be blocked by flags/limits (PRD FR-SOS).

---

## 8. Notification fan-out (async) — FR-NOTIFY

```mermaid
sequenceDiagram
    participant Svc as any service
    participant Bus as domain events
    participant NW as notifications.worker
    participant Push as Push/SMS
    participant DB as Postgres

    Svc->>Bus: emit trip.state_changed
    Bus->>NW: enqueue send job (dedup key)
    NW->>DB: resolve template + locale + channel prefs
    NW->>Push: send (push → SMS fallback)
    Note over NW: retry w/ backoff; duplicate events deduped
```
A notification failure never blocks the trip flow (HLD §7).

---

## 9. Document expiry sweep (scheduled) — FR-ONBOARD

```mermaid
sequenceDiagram
    participant CW as cleanup.worker (cron)
    participant DB as Postgres
    participant Drv as drivers
    participant Notif as notifications

    CW->>DB: find Documents expiring/expired
    CW->>Drv: recompute isOperable → false where invalid
    CW->>Notif: notify affected drivers to renew
```

---

## Cross-flow rules (apply to all workflows)

1. **Server-authoritative state** — clients reconcile via REST after any socket gap.
2. **Idempotent everywhere** — retried requests, duplicate socket messages, and re-run jobs are safe.
3. **Workers own time** — every timeout/deadline is a scheduled job, never a client timer.
4. **One writer per table** — a flow that needs another domain's data calls its service or emits an event.
5. **Everything money/state emits an audit record** — `TripEvent`, `LedgerEntry`, `SosEvent` are append-only.

See module/API detail in the [LLD](./ER_DIAGRAM.md) and component structure in the [HLD](./SYSTEM_ARCHITECTURE.md).
