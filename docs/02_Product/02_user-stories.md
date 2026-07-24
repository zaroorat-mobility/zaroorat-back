# User Stories & Acceptance Criteria

**Owner:** Product · **Last reviewed:** 2026-07-06

Each story is a thin, user-facing, testable slice. Acceptance criteria use **Given / When /
Then** so QA can turn them directly into tests (Volume 12). Story IDs (`US-<epic>-<n>`) are
referenced by the [traceability matrix](../03_Requirements/03_traceability-matrix.md).

> Format: **As a** ‹persona› **I want** ‹capability› **so that** ‹benefit›.

---

## E1 — Accounts & Authentication

### US-AUTH-01 — Sign up and verify with OTP

**As a** new rider **I want** to register with my phone number and verify via OTP **so that** I
can start booking quickly without a password.

- **Given** I enter a valid phone number, **When** I request an OTP, **Then** I receive a code by
  SMS within the delivery SLA and can enter it.
- **Given** I enter the correct OTP, **When** it is validated, **Then** my account is activated
  and I'm logged in with an access + refresh token.
- **Given** I enter a wrong OTP 5 times, **When** I try again, **Then** I'm rate-limited and told
  to wait / resend.
- **Given** SMS fails or is delayed, **When** the resend timer elapses, **Then** I can request a
  resend (and, if configured, a voice/fallback channel). _(A6.1)_

### US-AUTH-02 — Stay logged in / refresh session

**As a** returning user **I want** my session to persist **so that** I don't re-verify every time.

- **Given** a valid refresh token, **When** my access token expires, **Then** it refreshes
  silently; **When** the refresh token is expired/revoked, **Then** I'm asked to log in again.

---

## E2 — Driver Onboarding & KYC

### US-DRV-01 — Submit KYC documents

**As a** prospective driver **I want** to upload my documents **so that** I can be approved to drive.

- **Given** I'm a registered user, **When** I apply as a driver, **Then** I can upload Aadhaar/PAN,
  driving licence, and vehicle RC (+ permit/fitness if required).
- **Given** I submitted documents, **When** review is pending, **Then** I see status "under review"
  and **cannot** go online. _(R-KYC-2)_

### US-DRV-02 — Get approved / rejected with reason

**As a** prospective driver **I want** clear approval status **so that** I know what to fix.

- **Given** ops approves me, **When** approval completes, **Then** I can go online and my vehicle
  type is set.
- **Given** ops rejects me, **When** rejection is recorded, **Then** I see the reason and can resubmit.
- **Given** a document expires, **When** the expiry date passes, **Then** I'm moved to "documents
  required" and stop receiving requests. _(R-KYC-3)_

---

## E3 — Ride Request & Fare Estimate

### US-RIDE-01 — Set pickup and drop

**As a** rider **I want** to set my pickup and destination **so that** the app knows my trip.

- **Given** location permission, **When** I open booking, **Then** pickup defaults to my GPS
  location and I can adjust it on the map or by search.
- **Given** weak GPS, **When** the fix is poor, **Then** I can still set pickup manually. _(A6.2)_

### US-RIDE-02 — See the fare before confirming

**As a** rider **I want** to see the fare up front **so that** there are no surprises. _(R-PRICE-4)_

- **Given** a pickup, drop, and vehicle type, **When** I request an estimate, **Then** I see an
  itemized fare (base + distance + time, surge if any, total) **before** I confirm.
- **Given** surge is active, **When** the estimate is shown, **Then** the surge multiplier is
  disclosed and within the cap. _(R-PRICE-3)_
- **Given** I confirm, **When** the trip proceeds normally, **Then** the quoted fare is honored
  unless I change the route. _(R-PRICE-5)_

### US-RIDE-03 — Choose vehicle type

**As a** rider **I want** to choose car / auto / bike **so that** I pick what suits my trip & budget.

- **Given** available types in my area, **When** I select one, **Then** the estimate updates for
  that type; **Given** no drivers of a type nearby, **Then** it's shown as unavailable.

---

## E4 — Matching

### US-MATCH-01 — Get matched to a nearby driver

**As a** rider **I want** to be matched to a nearby driver **so that** I'm picked up quickly.

- **Given** I confirm a request, **When** matching runs, **Then** the nearest eligible driver of
  the right type is offered the trip. _(R-AVAIL-3/4)_
- **Given** a driver declines or times out, **When** matching continues, **Then** the next
  candidate is offered and the decliner isn't immediately re-offered. _(R-AVAIL-5)_
- **Given** no driver is found, **When** the radius has expanded to the limit, **Then** the
  request expires and I'm told none are available. _(R-AVAIL-6)_

### US-MATCH-02 — Driver receives and accepts an offer

**As a** driver **I want** clear, fast ride offers **so that** I can accept safely while stopped.

- **Given** I'm online and eligible, **When** an offer arrives, **Then** I see pickup, distance,
  ETA, and fare with an audible alert and large accept/decline. _(Imran persona)_
- **Given** I accept, **When** confirmed, **Then** the rider is notified and no other driver can
  accept the same request.

---

## E5 — Trip Lifecycle & Tracking

### US-TRIP-01 — Track my driver arriving

**As a** rider **I want** to see my driver approach **so that** I know when to be ready.

- **Given** a matched trip, **When** the driver moves, **Then** I see their live location, ETA,
  and vehicle/driver identity. _(R-SAFE-2)_

### US-TRIP-02 — Verify pickup with OTP

**As a** rider/driver **I want** a pickup OTP **so that** the right rider gets the right car. _(R-TRIP-2)_

- **Given** the driver arrives, **When** they start the trip, **Then** they must enter the rider's
  pickup OTP; **Given** a wrong OTP, **Then** the trip cannot start.

### US-TRIP-03 — Complete a trip

**As a** driver **I want** to end the trip and see the fare **so that** I can collect payment.

- **Given** an in-progress trip, **When** I end it at the destination, **Then** actual distance/
  time and final fare are recorded and shown to both. _(R-TRIP-3)_
- **Given** completion, **When** it's recorded, **Then** exactly one settlement is created. _(R-TRIP-4)_

### US-TRIP-04 — Recover from a connectivity drop

**As a** rider/driver **I want** the trip to survive a network drop **so that** I'm not stranded. _(A6.1)_

- **Given** an active trip, **When** my connection drops and returns, **Then** the app re-syncs the
  current trip state without creating a duplicate or losing the trip.

---

## E7 — Payments & Wallet

### US-PAY-01 — Pay by cash

**As a** rider **I want** to pay cash **so that** I can ride without a digital balance.

- **Given** a completed cash trip, **When** it settles, **Then** a ledger record captures fare,
  commission owed by driver, net, and tax. _(R-PAY-1, R-PAY-3)_

### US-PAY-02 — Pay by wallet

**As a** rider **I want** to pay from my wallet **so that** checkout is one tap.

- **Given** sufficient balance, **When** the trip completes, **Then** my wallet is debited exactly
  the fare, atomically, with no double-charge. _(R-PAY-6)_
- **Given** insufficient balance, **When** settlement is attempted, **Then** I'm prompted to top up
  or pay cash; my balance never goes negative. _(R-PAY-2)_

### US-PAY-03 — Driver sees transparent earnings

**As a** driver **I want** to see exactly what I earned **so that** I trust the platform. _(Imran)_

- **Given** completed trips, **When** I open earnings, **Then** I see per-trip fare, commission,
  tax, and net, plus a daily/weekly total and cash-vs-owed reconciliation. _(BR-8)_

---

## E9 — Ratings

### US-RATE-01 — Rate after a trip

**As a** rider/driver **I want** to rate the other party **so that** quality stays high.

- **Given** a completed trip, **When** I open the summary, **Then** I can give 1–5 stars and an
  optional comment, tied to that trip and not editable after the window. _(R-RATE-1/3)_

---

## E10 — Safety

### US-SAFE-01 — Share my trip

**As a** rider **I want** to share my live trip **so that** someone can watch my journey.

- **Given** an active trip, **When** I tap share, **Then** a link with live location + driver/
  vehicle details is generated for a contact. _(R-SAFE-1)_

### US-SAFE-02 — Trigger SOS

**As a** rider **I want** an SOS button **so that** I can get help fast.

- **Given** an active trip, **When** I trigger SOS, **Then** an alert with my identity, location,
  and trip is routed to ops/emergency per policy, and logged. _(R-SAFE-1/3)_

---

## E12 — Admin / Ops

### US-ADMIN-01 — Approve drivers

**As an** ops agent **I want** a review queue **so that** I can approve/reject drivers with evidence.

- **Given** pending applications, **When** I open the queue, **Then** I can view documents and
  approve/reject with a reason; every action is audit-logged. _(R-DATA-2)_

### US-ADMIN-02 — Resolve a dispute

**As an** ops agent **I want** trip evidence **so that** I can resolve disputes fairly.

- **Given** a disputed trip, **When** I open it, **Then** I see route, timing, fare breakdown,
  ledger entries, and chat/ratings; **When** I issue a refund, **Then** it's RBAC-gated, recorded
  with reason, and reflected in the ledger. _(R-PAY-5, R-DATA-2)_

### US-ADMIN-03 — Configure pricing & zones

**As an** ops agent (with permission) **I want** to tune pricing/surge and zones **so that** I can
respond to demand without a deploy. _(R-PRICE-6)_

- **Given** the pricing screen, **When** I change a parameter within allowed bounds, **Then** it
  takes effect for new estimates and is audit-logged with before/after.

---

## Story map (MVP flow order)

```
AUTH-01 → DRV-01/02 →           (onboarding)
RIDE-01/02/03 → MATCH-01/02 → TRIP-01/02/03 → PAY-01/02 → RATE-01     (core loop)
             ↘ SAFE-01/02 (always available during a trip)
ADMIN-01/02/03 (ops, throughout)
```
