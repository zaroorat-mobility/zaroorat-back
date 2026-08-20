# Rides Module Architecture & Operations

The **Rides Module** (`src/modules/rides/`) owns the core business logic for mobility trip lifecycle management, customer ride quoting & requests, driver matching offers, start-ride OTP verification, itemized fare calculation, cancellation fee assessment, post-trip receipt generation, and background expiry jobs.

---

## 1. Core Principles & Guarantees

1. **Strict State Machine**: Enforces non-bypassable trip state transitions:
   `REQUESTED` → `SEARCHING` → `ACCEPTED` → `DRIVER_ARRIVING` → `DRIVER_ARRIVED` → `IN_PROGRESS` → `COMPLETED`
   Cancellations (`CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_DRIVER`, `CANCELLED_BY_SYSTEM`) validate against state rules.
2. **Start-Ride OTP Security**: Generates cryptographically secure 4-digit PINs (`RideOtp`). Drivers must present valid OTPs (`POST /rides/:id/start`) to transition trips to `IN_PROGRESS`.
3. **Single-Occupancy Invariant**: Customers cannot create new ride requests while holding an active trip (`ACCEPTED`, `DRIVER_ARRIVING`, `DRIVER_ARRIVED`, `IN_PROGRESS`).
4. **Itemized Fare Engine**: Computes exact itemized fare breakdowns (`baseFare`, `distanceFare`, `timeFare`, `waitingCharge`, `surgeAmount`, `totalFare`, `driverEarning`, `platformCommission`).
5. **Durable Event Outbox**: All state transitions record `RideStatusEvent` rows and publish domain outbox events (`ride.requested`, `ride.accepted`, `ride.started`, `ride.completed`, `ride.cancelled`) within database transactions (`tx`).

---

## 2. Directory Structure

```
src/modules/rides/
│
├── controllers/                  # Fastify HTTP controllers (request, state, query, aggregator)
├── routes/                       # Route registrations (/api/v1/rides)
├── schemas/                      # Zod schemas, Response DTOs & Error envelopes
├── services/                     # Domain business services
│   ├── request/                  # RideRequest quote & creation service
│   ├── lifecycle/                # Ride state machine engine
│   ├── otp/                      # Start-ride OTP generator & verification service
│   ├── fare/                     # Itemized fare calculator service
│   ├── cancellation/             # Cancellation policy & fee evaluator service
│   ├── dispatch/                 # Driver dispatch & offer service
│   ├── receipt/                  # Post-trip receipt generator service
│   └── ride.service.ts           # Thin aggregated orchestrator service
├── repositories/                 # Prisma database access repositories
├── jobs/                         # Background workers (dispatch timeout, request expiry)
├── metrics/                      # Observability metrics (RideMetrics)
├── plugins/                      # Fastify plugin definition
├── events/                       # Domain event catalogue (RIDE_EVENT_CATALOG)
├── errors/                       # Custom domain error classes
├── constants/                    # Module constants
├── types/                        # Prisma entity re-exports & domain models
├── utils/                        # Haversine distance calculator & OTP crypto utilities
├── index.ts                      # Entry point & DI container registration
└── README.md                     # Production module documentation
```

---

## 3. Verification & Compliance

- `npx tsc --noEmit`: 0 errors
- `npm run test:unit`: 547 / 547 tests passing (including ride state machine, haversine distance, OTP verification, and itemized fare tests).
