# Payments Module Architecture & Operations

The **Payments Module** (`src/modules/payments/`) provides presigned intent charges, customer/driver wallet balance management with row-locking concurrency control, immutable double-entry financial accounting ledger records, gateway adapters (Razorpay / Stripe / Mock), idempotent webhook processing, driver earnings settlements, bank payouts, automated reconciliation, and refund safety checks.

---

## 1. Core Principles & Guarantees

1. **API Idempotency**: Header-enforced `Idempotency-Key` scoped to `userId` + `route` + `key`. Cached responses replay within a 24h window; parameter changes on the same key trigger a `409 Conflict`.
2. **Immutable Double-Entry Ledger**: Posts balanced `PaymentLedgerEntry` records (`Sum(Debits) == Sum(Credits)`). Append-only (`INSERT + READ ONLY`); zero updates or deletions allowed.
3. **Row-Level Locking Concurrency**: Wallet balance updates perform `SELECT ... FOR UPDATE` via `TransactionClient` inside `TransactionManager.execute()` to prevent double-spending.
4. **Authoritative Server Webhooks**: Gateway webhooks perform HMAC SHA256 signature verification and idempotent `GatewayEvent` processing (`at-least-once` delivery -> `effectively-once` execution).
5. **Settlement vs. Payout Isolation**: Driver settlement calculates period earnings; bank payout executes gateway transfers.

---

## 2. Directory Structure

```
src/modules/payments/
│
├── controllers/          # Fastify HTTP controllers (payment-method, wallet, intent, payout, refund, webhook)
├── routes/               # Route registrations (/api/v1/payments)
├── schemas/              # Zod schemas, Response DTOs & Error Envelopes
├── services/             # Domain business services
│   ├── wallet/           # Wallet balance, top-ups, holds & locks
│   ├── intent/           # PaymentIntent state machine & charges
│   ├── gateway/          # Gateway adapters (Razorpay / Stripe / Mock)
│   ├── ledger/           # Double-entry financial accounting ledger
│   ├── settlement/       # Period driver earnings calculator
│   ├── payout/           # Driver bank payout execution
│   ├── refund/           # Refund safety & amount cap validator
│   ├── webhook/          # HMAC signature & idempotent event engine
│   └── payment.service.ts# Thin orchestrator
├── repositories/         # Prisma database access repositories
├── jobs/                 # Settlement & Reconciliation workers
├── metrics/              # Observability metrics (PaymentMetrics)
├── plugins/              # Fastify plugin definition
├── events/               # Event catalogue (PAYMENT_EVENT_CATALOG)
├── errors/               # Domain errors (PaymentError, InsufficientBalanceError, etc.)
├── constants/            # Compile-time constants
├── types/                # Entity re-exports (Prisma models)
├── utils/                # Amount formatters (paise/cents) & HMAC verifiers
├── index.ts              # Entry point & DI container registration
└── README.md             # Production module documentation
```

---

## 3. Financial Integration & Concurrency Verification

- `npx tsc --noEmit`: 0 errors
- `npm run test:unit`: 540 / 540 tests passing (including idempotency, state machine, wallet concurrency, double-entry ledger, webhook HMAC, and refund tests).
