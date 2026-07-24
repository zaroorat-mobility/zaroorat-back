# LLD — Wallet & Ledger (`wallet`)

**Owner:** Engineering · **Last reviewed:** 2026-07-06
**Realizes:** FR-PAY-01..06, R-PAY-1..6, BR-5/8, NFR-COMPLY-01 (GST)

This is the money module. Its correctness is non-negotiable: every rupee must be traceable, no rupee
may be created or destroyed, and concurrent operations must never double-spend. We achieve this with
**double-entry accounting** on an **append-only ledger**. This is the most conservative, boring, and
correct design available — exactly what money demands.

---

## 1. Responsibility

`wallet` records every money movement as immutable ledger entries, maintains derived balances,
settles completed/cancelled trips, tracks driver earnings and commission-owed, and produces
reconcilable reports. It does **not** decide fares (`pricing`) or talk to external gateways
(`payments`). It is the **book of record** for money.

**Core principle — double-entry:** every transaction moves value between two (or more) accounts such
that **debits equal credits**. The books always balance to zero. This makes errors detectable (an
unbalanced entry is impossible to commit) and every balance explainable by summing its entries.

---

## 2. Account & ledger model

```mermaid
erDiagram
    ACCOUNT ||--o{ LEDGER_ENTRY : "has"
    TRANSACTION ||--|{ LEDGER_ENTRY : "groups (balanced)"
    ACCOUNT {
        id pk
        owner_type  "rider|driver|platform|tax|cash_clearing"
        owner_id
        currency    "INR"
    }
    LEDGER_ENTRY {
        id pk
        transaction_id fk
        account_id fk
        direction   "DEBIT|CREDIT"
        amount_paisa  "integer, minor units"
        created_at
    }
    TRANSACTION {
        id pk
        type   "trip_settlement|topup|payout|refund|cancellation_fee"
        trip_id
        idempotency_key
        created_at
    }
```

- **Accounts** are typed: rider wallets, driver earnings, the **platform revenue** account, a
  **tax/GST** account, and a **cash clearing** account (for cash trips). Everything is an account.
- **A `TRANSACTION` groups the ledger entries** that together must **sum to zero** (balanced). You
  never write a single entry; you write a balanced set.
- **`amount_paisa` is an integer in minor units** (paisa) — no floats anywhere (FR-DATA-03).
- Entries are **append-only**: never updated or deleted. A correction is a new, reversing
  transaction (R-DATA-1, R-PAY-1).
- **`idempotency_key`** on the transaction makes settlement/topups/refunds safe to retry.

---

## 3. Settlement examples (the important part)

### Wallet-paid trip (fare ₹200, 15% commission, GST 5% on commission)

| Account                       | Debit | Credit |
| ----------------------------- | ----: | -----: |
| Rider wallet                  |  ₹200 |        |
| Driver earnings               |       |   ₹170 |
| Platform revenue (commission) |       | ₹28.57 |
| Tax/GST payable               |       |  ₹1.43 |

Debits (₹200) = Credits (₹200). Rider pays 200; driver nets 170; platform keeps ~28.57 commission;
GST on the commission is booked separately so it's remittable (NFR-COMPLY-01). _(Exact GST base/rate
per tax advice — the model carries the field regardless.)_

### Cash-paid trip (same fare)

The driver collects ₹200 cash directly, so the driver **owes** the platform its commission+GST:

| Account                          | Debit | Credit |
| -------------------------------- | ----: | -----: |
| Cash clearing (driver collected) |  ₹200 |        |
| Driver earnings                  |       |   ₹170 |
| Platform revenue (commission)    |       | ₹28.57 |
| Tax/GST payable                  |       |  ₹1.43 |

Then the driver's **commission-owed** balance increases by ₹30 (settled from future wallet top-ups
or earnings). Same double-entry shape — only _which accounts_ differ (R-PAY-3). This is why cash and
wallet share one settlement path (Volume 4, Flow 4).

> **Invariant W-1:** every trip settlement is a balanced transaction (Σ debits = Σ credits). An
> unbalanced transaction cannot be committed — enforced in code and by a DB check.

---

## 4. Settlement logic (idempotent, event-driven)

Settlement is triggered by the `trip.completed` event (Volume 4), consumed by a worker:

```python
# wallet/settlement_service.py
async def settle(self, evt: TripCompleted) -> None:
    async with self._uow.transaction():
        if await self._repo.transaction_exists(idempotency_key=f"settle:{evt.trip_id}"):
            return                                   # already settled → no-op (R-TRIP-4)
        split = self._compute_split(evt.fare, evt.commission_rate, evt.gst_rate)
        entries = self._build_balanced_entries(evt, split)   # asserts Σ=0
        await self._repo.post_transaction(
            type=TRIP_SETTLEMENT, trip_id=evt.trip_id,
            idempotency_key=f"settle:{evt.trip_id}", entries=entries,
        )
```

- **Idempotency by `settle:{trip_id}`** guarantees exactly one settlement even if the event is
  redelivered (R-TRIP-4, Invariant I-3 from the trip FSM).
- `_build_balanced_entries` **asserts debits == credits** before posting — a programming error can
  never silently unbalance the books.

---

## 5. Concurrency — no double-spend (R-PAY-2/6)

Wallet debits (e.g. rider paying, or driver-owed deduction) must be concurrency-safe:

```python
async def debit_wallet(self, account_id: int, amount: int, key: str) -> Balance:
    async with self._uow.transaction():
        acct = await self._repo.get_account_for_update(account_id)  # row lock
        balance = await self._repo.balance(account_id)
        if balance < amount:
            raise InsufficientFundsError(account_id, amount)        # R-PAY-2: no negative
        await self._repo.post_transaction(... balanced entries ..., idempotency_key=key)
        return balance - amount
```

- **`SELECT … FOR UPDATE`** on the account row serializes concurrent debits — two simultaneous
  debits can't both read the old balance and both succeed (R-PAY-6).
- **Balance is derived** by summing entries (source of truth), optionally with a cached materialized
  balance kept consistent inside the same transaction. Never trust a cached balance for the guard.
- **No negative balances** (R-PAY-2) unless an explicit, configured overdraft policy applies.

---

## 6. Earnings, payouts, reconciliation — BR-8, R-PAY-4

- **Driver earnings view** is just a query over that driver's ledger entries: per-trip fare,
  commission, GST, net; daily/weekly totals; cash-collected vs commission-owed. Transparent by
  construction because it's the actual book (FR-PAY-04).
- **Payouts** debit the driver's earnings account and credit a payout-clearing account, tagged with
  the trips they cover, so every payout is traceable to specific trips (R-PAY-4/BR-8).
- **Daily reconciliation:** sum all entries per account; assert the global ledger sums to zero and
  that cash-clearing matches reported cash collection. Any drift pages finance (Volume 13). This is
  the check that catches fraud and bugs (BR-5).

---

## 7. Refunds — R-PAY-5

A refund is a **new reversing transaction**, never an edit of the original:

```
refund(trip): post balanced transaction crediting rider wallet, debiting platform revenue
              (and reversing GST proportionally), tagged type=REFUND, actor=ops_user,
              reason=..., idempotency_key=refund:{trip}:{n}
```

RBAC-gated (only authorized ops roles), audit-logged with actor + reason (FR-PAY-05, R-DATA-2),
and reflected in the ledger like everything else.

---

## 8. Edge cases & failure handling

| Edge case                                 | Handling                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `trip.completed` redelivered              | Idempotency key → no-op; books unchanged.                                                   |
| Wallet debit retried after network drop   | Same idempotency key → returns original result, single debit (A6.1, R-PAY-6).               |
| Concurrent debit + payout on same account | Row lock serializes; second waits and re-reads balance.                                     |
| Insufficient wallet balance at settlement | Prompt top-up or fall back to cash; balance never goes negative (R-PAY-2).                  |
| Rounding of commission/GST                | Compute in paisa, allocate remainder deterministically so Σ still balances (no lost paisa). |
| Correction needed                         | Post a reversing transaction; never mutate history (R-DATA-1).                              |

---

## 9. Invariants & traceability

**Invariants**

- **W-1** Every transaction balances (Σ debits = Σ credits). → `T-PAY-01`
- **W-2** Ledger is append-only; no updates/deletes. → `T-DATA-01`
- **W-3** No account goes negative without explicit overdraft config. → `T-PAY-02`
- **W-4** Exactly one settlement per completed trip. → `T-PAY-01`, trip I-3
- **W-5** Global ledger sums to zero at all times. → reconciliation `T-PAY-*`
- **W-6** Every money movement carries its GST/tax component. → `T-PAY-01`, NFR-COMPLY-01

**Traceability**

| Design element                     | Satisfies                     |
| ---------------------------------- | ----------------------------- |
| Double-entry balanced transactions | R-PAY-1, FR-PAY-01, BR-5      |
| Cash settlement path               | R-PAY-3, FR-PAY-02            |
| Row-lock debit, no negative        | R-PAY-2/6, FR-PAY-03          |
| Transparent earnings query         | BR-8, FR-PAY-04               |
| Traceable payouts                  | R-PAY-4, FR-PAY-06            |
| Reversing refunds, RBAC + audit    | R-PAY-5, FR-PAY-05, R-DATA-2  |
| GST/tax account                    | NFR-COMPLY-01, GST assumption |
