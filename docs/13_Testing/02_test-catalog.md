# Test Catalog & Traceability

**Owner:** Engineering (QA) · **Last reviewed:** 2026-07-06

This is where the chain closes. The [traceability matrix (V3)](../03_Requirements/03_traceability-matrix.md)
promised a `T-###` test for every rule and FR; this catalog defines them. Each entry names the test,
its level, what it asserts, and the rule/FR/invariant it proves. **A MUST requirement without a
green test here is a release blocker.**

> Level key: **U** unit · **I** integration · **A** API · **E** E2E · **L** load · **S** security.

---

## Auth & accounts

| Test        | Lvl | Asserts                                               | Proves                     |
| ----------- | --- | ----------------------------------------------------- | -------------------------- |
| `T-AUTH-01` | A   | OTP request→verify activates account & returns tokens | R-ACCOUNT-1, FR-AUTH-01/02 |
| `T-AUTH-02` | I   | one account per phone per role; dual role allowed     | R-ACCOUNT-2/3, FR-AUTH-05  |
| `T-AUTH-03` | A   | suspended account cannot book/accept                  | R-ACCOUNT-4, FR-AUTH-06    |
| `T-AUTH-04` | U   | wrong OTP ×N → lockout; rate limit on requests        | FR-AUTH-03, A-1            |
| `T-AUTH-05` | I   | refresh rotation; reused old refresh → chain revoked  | FR-AUTH-07, A-3            |

## Driver KYC & eligibility

| Test       | Lvl | Asserts                                                       | Proves                  |
| ---------- | --- | ------------------------------------------------------------- | ----------------------- |
| `T-KYC-01` | A   | applicant can upload Aadhaar/PAN/DL/RC                        | R-KYC-1, FR-KYC-01      |
| `T-KYC-02` | U   | non-approved driver cannot go online / be matched             | R-KYC-2, D-1, FR-KYC-02 |
| `T-KYC-03` | I   | expired required doc → `docs_required`, removed from matching | R-KYC-3, D-2            |
| `T-KYC-04` | I   | trip uses the active vehicle assignment (not fixed 1:1)       | FR-KYC-05, D-3          |

## Matching

| Test         | Lvl | Asserts                                                         | Proves             |
| ------------ | --- | --------------------------------------------------------------- | ------------------ |
| `T-MATCH-01` | U   | only eligible drivers offered (online/approved/free/type/fresh) | R-AVAIL-1/2/3, M-3 |
| `T-MATCH-02` | U   | ranking prefers nearest, fairness breaks near-ties              | R-AVAIL-4          |
| `T-MATCH-03` | U   | declined driver not re-offered within cooldown                  | R-AVAIL-5, M-2     |
| `T-MATCH-04` | I   | radius expands then request expires on deadline                 | R-AVAIL-6, M-4     |
| `T-MATCH-05` | I   | **concurrent accepts → exactly one wins**                       | FR-MATCH-05, I-2   |
| `T-MATCH-06` | I   | one matching loop per request (redelivered event)               | M-1                |

## Trip lifecycle

| Test        | Lvl | Asserts                                                       | Proves                    |
| ----------- | --- | ------------------------------------------------------------- | ------------------------- |
| `T-TRIP-01` | U   | only legal FSM transitions succeed; illegal → 409             | R-TRIP-1, FR-TRIP-01, I-5 |
| `T-TRIP-02` | U   | wrong pickup OTP keeps trip `arrived`                         | R-TRIP-2, I-4, FR-TRIP-02 |
| `T-TRIP-03` | U   | completion records actual distance/time/fare                  | R-TRIP-3, FR-TRIP-04      |
| `T-TRIP-04` | I   | **completed trip → exactly one settlement** (redelivery-safe) | R-TRIP-4, I-3, FR-TRIP-05 |
| `T-TRIP-05` | U   | terminal states final & mutually exclusive                    | R-TRIP-5, I-1, FR-TRIP-06 |
| `T-TRIP-06` | I   | outbox: rollback → no event; commit → exactly one             | I-3, Volume 5 §08         |

## Cancellation

| Test          | Lvl | Asserts                                          | Proves                     |
| ------------- | --- | ------------------------------------------------ | -------------------------- |
| `T-CANCEL-01` | U   | either party cancels pre-pickup; reason captured | R-CANCEL-1, FR-CANCEL-01   |
| `T-CANCEL-02` | U   | rider fee only after grace window, disclosed     | R-CANCEL-2/4, FR-CANCEL-02 |
| `T-CANCEL-03` | U   | driver cancel → no rider fee; score impact       | R-CANCEL-3, FR-CANCEL-03   |

## Pricing

| Test         | Lvl | Asserts                                                           | Proves                          |
| ------------ | --- | ----------------------------------------------------------------- | ------------------------------- |
| `T-PRICE-01` | U   | fare = base+dist+time; never below minimum                        | R-PRICE-1/2, P-1, FR-PRICE-01   |
| `T-PRICE-02` | U   | surge clamped to [1.0, cap] and disclosed                         | R-PRICE-3, P-2, FR-PRICE-03     |
| `T-PRICE-03` | A   | estimate returned before booking, itemized                        | R-PRICE-4, FR-RIDE-02           |
| `T-PRICE-04` | U   | quoted fare honored unless route materially changes               | R-PRICE-5, P-5                  |
| `T-PRICE-05` | I   | pricing change via config takes effect for new estimates, audited | R-PRICE-6, P-3/P-4, FR-ADMIN-05 |

## Wallet & money (highest-risk — adversarial)

| Test       | Lvl | Asserts                                                       | Proves                      |
| ---------- | --- | ------------------------------------------------------------- | --------------------------- |
| `T-PAY-01` | U   | every settlement balances (Σ debits = Σ credits), carries GST | R-PAY-1, W-1/W-6, FR-PAY-01 |
| `T-PAY-02` | I   | **concurrent debits never overdraw** (row lock)               | R-PAY-2/6, W-3, FR-PAY-03   |
| `T-PAY-03` | U   | cash settlement path books commission-owed                    | R-PAY-3, FR-PAY-02          |
| `T-PAY-04` | I   | payout traceable to specific trips                            | R-PAY-4, FR-PAY-06          |
| `T-PAY-05` | A   | refund is RBAC-gated, reversing txn, audited                  | R-PAY-5, FR-PAY-05          |
| `T-PAY-06` | U   | earnings breakdown = fare/commission/tax/net                  | BR-8, FR-PAY-04             |
| `T-PAY-07` | I   | **idempotent settlement/debit** (same key → one effect)       | NFR-RESIL-02, W-4           |
| `T-PAY-08` | I   | global ledger reconciles to zero                              | W-5                         |

## Ratings, safety, data

| Test        | Lvl | Asserts                                                       | Proves                    |
| ----------- | --- | ------------------------------------------------------------- | ------------------------- |
| `T-RATE-01` | U   | 1–5 rating tied to trip, immutable after window, one each way | R-RATE-1/3                |
| `T-RATE-02` | U   | driver below threshold flagged for review                     | R-RATE-2                  |
| `T-SAFE-01` | A   | share-trip + SOS available on active trip                     | R-SAFE-1, FR-SAFE-01/03   |
| `T-SAFE-02` | A   | driver+vehicle identity shown once matched                    | R-SAFE-2, FR-SAFE-02      |
| `T-SAFE-03` | I   | SOS logged + routed; trip location retained                   | R-SAFE-3/4                |
| `T-DATA-01` | I   | ledger/audit append-only (no update/delete path)              | R-DATA-1, W-2, FR-DATA-01 |
| `T-DATA-02` | A   | admin actions audit-logged with actor + before/after          | R-DATA-2, FR-ADMIN-04     |
| `T-DATA-03` | I   | soft-deleted rows excluded by default queries                 | R-DATA-1, FR-DATA-02      |

## Resilience & notifications (A6.1)

| Test         | Lvl | Asserts                                                                 | Proves                         |
| ------------ | --- | ----------------------------------------------------------------------- | ------------------------------ |
| `T-RESIL-01` | E   | drop mid-trip → reconnect → `GET /trips/active` reconciles; no dup/loss | A6.1, FR-TRIP-07, NFR-RESIL-05 |
| `T-RESIL-02` | I   | every mutating endpoint idempotent (replay = one effect)                | NFR-RESIL-02                   |
| `T-RESIL-03` | I   | critical event falls back to SMS when push unavailable                  | FR-NOTIF-02, N-1, A6.1         |

---

## Coverage assertion (CI gate)

CI cross-checks this catalog against the traceability matrix:

- [ ] Every **MUST FR** in [V3](../03_Requirements/03_traceability-matrix.md) has ≥1 green `T-`.
- [ ] Every **invariant** (I-/M-/P-/W-/A-/D-/N- in Volumes 5–6) has a `T-` asserting it.
- [ ] No `T-` references a rule/FR that doesn't exist (no orphan tests).
- [ ] Money & FSM race tests (`T-MATCH-05`, `T-TRIP-04`, `T-PAY-01/02/07/08`) are present and green.

> A new FR (V3) that adds a matrix row **must** add its `T-` here in the same PR — the chain is only
> as strong as its last link. This catalog is that link.
