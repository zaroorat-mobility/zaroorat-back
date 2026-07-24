# Endpoint Catalog

**Owner:** Engineering (API) · **Last reviewed:** 2026-07-06

Every REST endpoint, grouped by module, mapped to the functional requirement it serves. All paths
are prefixed `/api/v1`. `🔒` = requires auth; `👮` = requires an ops/admin RBAC scope. Request/
response bodies are camelCase JSON. This catalog is derived from — and must stay in sync with — the
generated OpenAPI spec ([05](05_openapi-and-clients.md)).

---

## auth

| Method | Path                  | Purpose                     | FR            |
| ------ | --------------------- | --------------------------- | ------------- |
| `POST` | `/auth/otp/request`   | Send OTP to a phone         | FR-AUTH-01/02 |
| `POST` | `/auth/otp/verify`    | Verify OTP → tokens         | FR-AUTH-01    |
| `POST` | `/auth/token/refresh` | Rotate refresh → new tokens | FR-AUTH-04/07 |
| `POST` | `/auth/logout` 🔒     | Revoke refresh token        | FR-AUTH-07    |

```http
POST /api/v1/auth/otp/request
{ "phone": "+919000000000" }
→ 202 Accepted
{ "resendAfterSec": 30, "channel": "sms" }
```

```http
POST /api/v1/auth/otp/verify
{ "phone": "+919000000000", "code": "123456" }
→ 200 OK
{ "accessToken": "eyJ…", "refreshToken": "eyJ…", "expiresInSec": 1800,
  "user": { "id": "u_123", "roles": ["rider"], "name": null } }
```

## users / profile

| Method  | Path                 | Purpose                  | FR  |
| ------- | -------------------- | ------------------------ | --- |
| `GET`   | `/users/me` 🔒       | Current profile          | —   |
| `PATCH` | `/users/me` 🔒       | Update name/locale       | —   |
| `GET`   | `/users/me/trips` 🔒 | Trip history (paginated) | E5  |

## drivers & onboarding

| Method | Path                         | Purpose                                 | FR          |
| ------ | ---------------------------- | --------------------------------------- | ----------- |
| `POST` | `/drivers/apply` 🔒          | Become a driver applicant               | FR-KYC-01   |
| `POST` | `/drivers/me/documents` 🔒   | Upload a KYC document                   | FR-KYC-01   |
| `GET`  | `/drivers/me` 🔒             | Driver state + KYC status               | FR-KYC-02   |
| `POST` | `/drivers/me/online` 🔒      | Go online (must be approved)            | R-AVAIL-1   |
| `POST` | `/drivers/me/offline` 🔒     | Go offline                              | —           |
| `POST` | `/drivers/me/location` 🔒    | Push a location fix                     | R-AVAIL-2   |
| `GET`  | `/drivers/me/eligibility` 🔒 | Why am I / am I not matchable (reasons) | FR-MATCH-01 |

```http
POST /api/v1/drivers/me/online
→ 409 Conflict
{ "error": { "code": "driver_not_approved",
             "message": "Complete KYC before going online.",
             "details": { "state": "under_review" } } }
```

## vehicles

| Method | Path              | Purpose                         | FR        |
| ------ | ----------------- | ------------------------------- | --------- |
| `POST` | `/vehicles` 🔒    | Register a vehicle              | FR-KYC-05 |
| `GET`  | `/vehicles/me` 🔒 | My vehicles + active assignment | FR-KYC-05 |

## rides & trips (the core)

| Method | Path                            | Purpose                                          | FR                    |
| ------ | ------------------------------- | ------------------------------------------------ | --------------------- |
| `POST` | `/rides/estimate` 🔒            | Fare estimate before booking                     | FR-RIDE-02, R-PRICE-4 |
| `POST` | `/rides` 🔒 ⏱                   | Create a ride request (starts matching)          | FR-RIDE-05            |
| `GET`  | `/trips/active` 🔒              | **Authoritative current trip state** (reconnect) | FR-TRIP-07            |
| `GET`  | `/trips/{tripId}` 🔒            | Trip detail                                      | E5                    |
| `POST` | `/trips/{tripId}/accept` 🔒 ⏱   | Driver accepts (FSM T2)                          | FR-MATCH-05           |
| `POST` | `/trips/{tripId}/arrived` 🔒 ⏱  | Driver at pickup (T5)                            | FR-TRIP-01            |
| `POST` | `/trips/{tripId}/start` 🔒 ⏱    | Start with pickup OTP (T8)                       | FR-TRIP-02            |
| `POST` | `/trips/{tripId}/complete` 🔒 ⏱ | Complete trip (T9)                               | FR-TRIP-04/05         |
| `POST` | `/trips/{tripId}/cancel` 🔒 ⏱   | Cancel (T4/T6/T7)                                | FR-CANCEL-01          |

`⏱` = **requires `Idempotency-Key`**.

```http
POST /api/v1/rides/estimate
{ "pickup": {"lat":34.0837,"lng":74.7973}, "drop": {"lat":34.1,"lng":74.81},
  "vehicleType": "auto" }
→ 200 OK
{ "vehicleType": "auto",
  "fare": { "amount": 15000, "currency": "INR", "display": "₹150.00" },
  "breakdown": { "baseFare": 3000, "distance": 9000, "time": 3000, "bookingFee": 0 },
  "surge": { "multiplier": 1.0, "applied": false },
  "etaMinutes": 4, "approximate": false }
```

```http
POST /api/v1/rides
Idempotency-Key: 6f1c…-a2
{ "pickup": {…}, "drop": {…}, "vehicleType": "auto", "estimateId": "est_88" }
→ 201 Created
{ "tripId": "t_4821", "state": "searching", "createdAt": "2026-07-06T10:12:00Z" }
```

```http
POST /api/v1/trips/t_4821/start
Idempotency-Key: 6f1c…-a9
{ "pickupOtp": "4417" }
→ 200 OK  { "tripId": "t_4821", "state": "in_progress", "startedAt": "…" }
→ 409     { "error": { "code": "invalid_pickup_otp", "message": "…" } }   # wrong OTP (R-TRIP-2)
```

```http
GET /api/v1/trips/active     # after a reconnect (Flow 5)
→ 200 OK
{ "tripId": "t_4821", "state": "in_progress",
  "driver": { "name": "Imran", "rating": 4.8, "vehicle": {"type":"auto","reg":"JK01…"} },
  "fare": { "amount": 15000, "currency": "INR", "display": "₹150.00" },
  "pickup": {…}, "drop": {…} }
```

## pricing / zones (mostly admin)

| Method  | Path                 | Purpose                             | FR                       |
| ------- | -------------------- | ----------------------------------- | ------------------------ |
| `GET`   | `/pricing/config` 👮 | Current pricing config (city, type) | FR-PRICE-02              |
| `PATCH` | `/pricing/config` 👮 | Update pricing (audited)            | FR-PRICE-02, FR-ADMIN-05 |
| `GET`   | `/zones` 👮          | List zones                          | R-PRICE-3                |
| `POST`  | `/zones` 👮          | Create/update a zone polygon        | R-PRICE-3                |

## wallet & payments

| Method | Path                         | Purpose                              | FR              |
| ------ | ---------------------------- | ------------------------------------ | --------------- |
| `GET`  | `/wallet/me` 🔒              | Balance                              | R-PAY-2         |
| `POST` | `/wallet/me/topup` 🔒 ⏱      | Top up wallet (phase 2: UPI)         | E7              |
| `GET`  | `/wallet/me/transactions` 🔒 | Ledger statement (paginated)         | R-PAY-1         |
| `GET`  | `/drivers/me/earnings` 🔒    | Per-trip & period earnings breakdown | FR-PAY-04, BR-8 |
| `POST` | `/drivers/me/payouts` 🔒 ⏱   | Request a payout                     | FR-PAY-06       |
| `POST` | `/admin/refunds` 👮 ⏱        | Issue a refund (audited)             | FR-PAY-05       |

## ratings

| Method | Path                          | Purpose                    | FR         |
| ------ | ----------------------------- | -------------------------- | ---------- |
| `POST` | `/trips/{tripId}/rating` 🔒 ⏱ | Rate the other party (1–5) | FR-RATE-01 |

## safety

| Method | Path                       | Purpose                           | FR         |
| ------ | -------------------------- | --------------------------------- | ---------- |
| `POST` | `/trips/{tripId}/share` 🔒 | Create a share-trip link          | FR-SAFE-01 |
| `GET`  | `/share/{token}`           | Public live view of a shared trip | FR-SAFE-01 |
| `POST` | `/trips/{tripId}/sos` 🔒 ⏱ | Trigger SOS                       | FR-SAFE-03 |

## notifications

| Method   | Path                                   | Purpose               | FR          |
| -------- | -------------------------------------- | --------------------- | ----------- |
| `POST`   | `/notifications/device-tokens` 🔒      | Register a push token | FR-NOTIF-01 |
| `DELETE` | `/notifications/device-tokens/{id}` 🔒 | Remove a token        | —           |

## admin / ops (👮 — RBAC-scoped)

| Method | Path                                 | Purpose                             | FR          |
| ------ | ------------------------------------ | ----------------------------------- | ----------- |
| `GET`  | `/admin/drivers?status=under_review` | Onboarding queue                    | FR-KYC-03   |
| `POST` | `/admin/drivers/{id}/approve` ⏱      | Approve driver (audited)            | FR-KYC-03   |
| `POST` | `/admin/drivers/{id}/reject` ⏱       | Reject with reason (audited)        | FR-KYC-03   |
| `GET`  | `/admin/trips?state=…&from=…`        | Search trips (evidence)             | FR-ADMIN-02 |
| `GET`  | `/admin/trips/{id}`                  | Trip evidence (route, ledger, chat) | FR-ADMIN-02 |
| `POST` | `/admin/users/{id}/suspend` ⏱        | Suspend account (audited)           | R-ACCOUNT-4 |
| `GET`  | `/admin/dashboard/live`              | Live supply/demand + active trips   | FR-ADMIN-01 |
| `GET`  | `/admin/reports/{metric}`            | Metric reports (V2 KPIs)            | Volume 2    |

## webhooks (phase 2)

| Method | Path                            | Purpose                                         |
| ------ | ------------------------------- | ----------------------------------------------- |
| `POST` | `/webhooks/payments/{provider}` | Inbound payment/UPI events (signature-verified) |

---

## Endpoint → module → FR alignment

Every endpoint above maps to a module (Volume 5) and a functional requirement (Volume 3). The
traceability matrix ([Volume 3](../03_Requirements/03_traceability-matrix.md)) plus this catalog
means: **for any FR you can find its endpoint, and for any endpoint you can find its rule and its
test.** New endpoints must add their FR mapping here in the same PR.
