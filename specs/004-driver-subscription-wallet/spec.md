# Feature Specification: Driver Subscription & Commission Wallet

**Feature Branch**: `004-driver-subscription-wallet`

**Created**: 2026-09-08 | **Revised**: 2026-09-08 (dual payment-model revision — see [revision-002-dual-model.md](./revision-002-dual-model.md) for the full rationale and business-rule diff against the original single-model draft)

**Status**: Draft

**Input**: User description: "Two distinct driver payment models. MODEL 1 (Subscription-based): a driver pays for a 1-Day/Weekly/Monthly plan through the company's payment collection mechanism; once active, the subscription alone makes the driver eligible for rides, with no commission-wallet requirement or deduction of any kind for rides taken under this model. MODEL 2 (Commission-based): a driver maintains a Commission Wallet, manually recharged with either a custom amount or a company-configured predefined amount; before each ride, the backend checks the wallet's balance against the ride's expected commission and blocks the ride if insufficient, with no reservation/freeze mechanism (the platform's existing one-active-ride-per-driver rule already prevents the race a reservation would otherwise guard against); on completion, the final commission is deducted from the wallet (capped so the wallet never goes negative), recorded as an immutable transaction, and posted to the company's ledger. A driver has exactly one payment model at a time; a ride is always processed under whichever model applied when it was accepted, even if the driver's model later changes. Customer ride payment, driver earnings/payout, and the customer wallet remain fully separate flows in both models."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Driver selects a payment model (Priority: P1)

Before a driver can be eligible for any ride, they choose how they will pay the platform for it: `SUBSCRIPTION` or `COMMISSION`. This choice determines which of the two workflows below governs their rides until they explicitly change it.

**Why this priority**: Every other story in this feature depends on knowing which model applies to a given driver — it is the routing decision the backend must make before any eligibility check.

**Independent Test**: Can be fully tested by having a new driver with no prior selection attempt to be offered a ride (expect rejection, no model selected), then select a model and verify the system now records it — independent of subscription or wallet activity.

**Acceptance Scenarios**:

1. **Given** a driver who has never selected a payment model, **When** an attempt is made to offer them a ride, **Then** the ride offer is not made, regardless of any subscription or wallet state that might otherwise exist.
2. **Given** a driver with no current payment model, **When** they select `SUBSCRIPTION` or `COMMISSION`, **Then** the system records that model as effective immediately.
3. **Given** a driver who already has an active model, **When** they request to switch to the other model, **Then** the switch is scheduled to take effect at a well-defined future point (never retroactively — see User Story 2/3 for the specific timing rules) and never changes how a ride already accepted before the switch is processed.

---

### User Story 2 - Subscription-based driver subscribes to a plan (Priority: P1)

A driver using the `SUBSCRIPTION` model selects a company-defined plan (1-Day, Weekly, or Monthly), pays for it through the company's payment collection mechanism, and — once payment is confirmed — their subscription becomes active, making them eligible for rides for the paid period. No commission wallet is involved anywhere in this driver's ride flow.

**Why this priority**: This is one of the two foundational, mutually exclusive ways a driver becomes ride-eligible.

**Independent Test**: Can be fully tested by having a subscription-model driver with no active subscription select a plan, complete payment, and verify they now have an active subscription with a defined expiry date, then complete a ride and verify no wallet transaction of any kind was created.

**Acceptance Scenarios**:

1. **Given** a subscription-model driver with no active subscription, **When** they select a 1-Day, Weekly, or Monthly plan and complete payment, **Then** the system activates a subscription with a start date and an expiry date matching the plan's billing period.
2. **Given** a driver whose plan payment fails or is not confirmed, **When** the payment attempt ends, **Then** no subscription is activated and the driver's prior subscription state (if any) is unchanged.
3. **Given** a subscription-model driver with no active subscription, **When** an attempt is made to offer them a ride, **Then** the ride offer is not made to that driver.
4. **Given** a subscription-model driver with an active subscription who completes a ride, **When** the ride finishes, **Then** no Commission Wallet transaction and no commission ledger entry are created for that ride — the subscription fee already paid is the entirety of this driver's commission obligation for rides during the active period.

---

### User Story 3 - Commission-based driver recharges their wallet (Priority: P1)

A driver using the `COMMISSION` model adds money to their Commission Wallet — either a custom amount or one of the company's configured predefined amounts — through the company's payment collection mechanism, so they have funds available to cover future ride commissions.

**Why this priority**: The wallet must be fundable before it can be checked or drawn against — foundational to the commission model exactly as subscribing is foundational to the subscription model.

**Independent Test**: Can be fully tested by having a driver initiate a recharge (custom amount, then separately a predefined amount), completing payment through the provider, and verifying the wallet's balance increases by exactly the confirmed amount only after the provider confirms the payment.

**Acceptance Scenarios**:

1. **Given** a commission-model driver with a Commission Wallet, **When** they successfully complete a recharge payment for a custom amount within the company's configured range and the payment provider confirms it, **Then** the wallet's balance increases by exactly that amount and a permanent transaction record is created.
2. **Given** the same driver, **When** they instead select one of the company's configured predefined recharge amounts and the payment provider confirms it, **Then** the wallet's balance increases by exactly that amount, identically to a custom-amount recharge.
3. **Given** a recharge payment that the provider reports as failed or that times out, **When** the recharge attempt concludes, **Then** the wallet balance is unchanged and the attempt is recorded as failed.
4. **Given** a recharge confirmation notification that the provider sends more than once for the same payment, **When** the system processes the duplicate notification, **Then** the wallet is credited only once for that payment.
5. **Given** the app or client claims a recharge succeeded, **When** the backend has not independently received provider confirmation, **Then** the wallet balance is not increased.
6. **Given** a driver submits a custom recharge amount outside the company's configured minimum/maximum, **When** the request is validated, **Then** it is rejected before any payment is initiated.

---

### User Story 4 - Backend determines ride commission and enforces wallet-based ride eligibility for commission-based drivers (Priority: P1)

Before a commission-model ride is accepted, the backend determines the commission applicable to that specific ride — once — and checks the driver's authoritative wallet balance against that determined amount. If the wallet cannot cover it, that driver does not receive/cannot accept the ride. This check never applies to subscription-based drivers, and it never sets aside or locks any part of the wallet balance — it is a plain comparison. The determined commission amount is not a preliminary guess subject to later revision — it is fixed for this ride at this moment, and is the exact amount that will be deducted at completion (see User Story 5). It is called the ride's **determined commission amount** (or **stored ride commission**) throughout this specification, not an "estimate," because nothing about it is re-derived later.

**Why this priority**: This is the core financial-protection mechanism for the commission model — without it, the company has no way to guarantee it collects commission on rides a commission-based driver completes.

**Independent Test**: Can be fully tested by setting a commission-model driver's wallet to a known balance and attempting to accept a ride whose determined commission exceeds that balance (expect rejection) versus one that doesn't (expect success, with the wallet balance unchanged and the determined commission amount now stored on the ride, immediately after acceptance).

**Acceptance Scenarios**:

1. **Given** a commission-model driver with a wallet balance of ₹500, **When** a ride whose determined commission is ₹100 is being assigned, **Then** the driver is eligible, the ride assignment proceeds, the ₹100 is stored permanently on the ride, and the wallet balance is unaffected by the acceptance itself.
2. **Given** a commission-model driver with a wallet balance of ₹50, **When** a ride whose determined commission is ₹100 is being assigned, **Then** the ride is not assigned to that driver and the driver is informed they must recharge.
3. **Given** the eligibility check is performed, **When** it evaluates the driver's balance, **Then** it uses only the backend's own stored wallet balance and never a balance value supplied by the requesting client.
4. **Given** a subscription-model driver, **When** a ride is being assigned to them, **Then** no wallet balance of any kind is checked and no commission amount is determined or stored — only their subscription status matters.
5. **Given** a commission-model driver, **When** a ride is being assigned to them, **Then** no subscription status of any kind is checked — only their wallet balance against the ride's determined commission matters.

---

### User Story 5 - Commission is deducted automatically on ride completion for commission-based drivers (Priority: P2)

When a ride accepted under the `COMMISSION` model finishes, the backend uses the commission amount already determined and stored on the ride at acceptance. It does not recalculate the commission. The **full** stored commission amount is deducted from the driver's Commission Wallet — never a partial amount — and the deduction is recorded permanently with the corresponding accounting entry crediting the company's commission account. Because the driver's wallet was already verified sufficient at acceptance, and nothing else in normal operation spends from this wallet while a ride is active, the wallet balance at completion is expected to always cover the stored commission amount; if it unexpectedly does not, that is treated as an exceptional condition requiring investigation, not a routine partial collection (see User Story 5a).

**Why this priority**: This is where the company actually collects what it is owed under the commission model; it depends on User Story 4 having run first, so it is sequenced after it, but it is equally essential.

**Independent Test**: Can be fully tested by completing a commission-model ride and verifying the wallet balance drops by exactly the ride's stored commission amount, a permanent transaction record exists, and a balanced accounting entry exists — with no commission calculation of any kind performed during completion.

**Acceptance Scenarios**:

1. **Given** a completed commission-model ride (the normal case — the driver's wallet balance covers the stored commission amount, as guaranteed by the acceptance-time check), **When** completion processing runs, **Then** the wallet balance is reduced by exactly the full stored commission amount (read, not recalculated, never partial), and one immutable wallet transaction plus one balanced accounting entry are created.
2. **Given** a ride whose commission has already been deducted once, **When** completion processing is triggered again for the same ride (e.g. a retry), **Then** the commission is not deducted a second time and no recalculation is attempted.
3. **Given** a ride completes, **When** the commission is deducted, **Then** the wallet deduction and the accounting entry either both take effect or neither does — there is never a state where one exists without the other.
4. **Given** a ride's stored commission amount is read at completion, **When** the deduction takes place, **Then** it does not depend on a live call to the payment provider within the same operation that deducts the wallet.
5. **Given** a ride's final customer fare is determined or confirmed at completion, **When** that happens, **Then** it has no effect on the ride's already-stored commission amount — the two are separate values, and confirming or changing one never changes the other.

---

### User Story 5a - Insufficient wallet balance at completion is handled as an exceptional condition, never a partial collection (Priority: P2)

If, at the moment a commission-model ride completes, the driver's wallet balance is unexpectedly less than the ride's stored commission amount, the backend does not deduct a partial amount, does not record a shortfall or debt, and does not create a wallet transaction claiming the commission was collected. It records the condition for investigation and leaves the wallet untouched by that ride's commission.

**Why this priority**: This is the direct counterpart to User Story 5's normal case, and — like User Story 6 for the subscription model — must be stated explicitly so a system that only tests the normal case cannot silently reintroduce partial-deduction behavior.

**Independent Test**: Can be fully tested by manually reducing a commission-model driver's wallet balance below a ride's stored commission amount after acceptance (e.g. via an administrative adjustment) and completing that ride, then confirming no wallet transaction and no ledger entry were created for that ride's commission, and that the condition was recorded for investigation.

**Acceptance Scenarios**:

1. **Given** a commission-model ride whose stored commission amount exceeds the driver's wallet balance at the moment of completion, **When** completion processing runs, **Then** no amount is deducted from the wallet, no `RIDE_COMMISSION` wallet transaction is created, and no ledger entry is posted for that ride's commission.
2. **Given** the same situation, **When** it occurs, **Then** the system records the condition (driver, ride, stored commission amount, actual balance found) in a form usable for investigation and reconciliation, without creating any new debt, receivable, or shortfall-balance record for the driver.
3. **Given** the same situation, **When** it occurs, **Then** the rest of ride completion (the ride's status, fare, and customer-facing outcome) is unaffected — this condition affects only the commission-collection step, not the ride itself.
4. **Given** the wallet balance was sufficient at acceptance, **When** this situation nonetheless occurs at completion, **Then** it is understood and documented as arising only from something outside the ride's own lifecycle changing the balance in between (e.g. an administrative adjustment) — never from the commission amount itself changing, since it is never recalculated (User Story 4/5).

---

### User Story 6 - Subscription-based ride completes with no wallet involvement (Priority: P2)

When a ride accepted under the `SUBSCRIPTION` model finishes, the backend records the ride's completion exactly as it otherwise would, but performs no Commission Wallet check, transaction, or ledger entry of any kind for that ride.

**Why this priority**: This is the direct counterpart to User Story 5 and must be stated explicitly, since a system that only ever tested the commission path could otherwise silently deduct commission from a subscription-based driver by mistake.

**Independent Test**: Can be fully tested by completing a subscription-model ride and confirming no Commission Wallet transaction, no commission ledger entry, and no wallet balance change occurred as a result.

**Acceptance Scenarios**:

1. **Given** a driver whose ride was accepted while they were a subscription-model driver, **When** the ride completes — even if the driver has since switched to the commission model — **Then** no Commission Wallet activity of any kind occurs for that ride.
2. **Given** a subscription-model ride completes, **When** normal ride/payment information (fare, receipt, etc.) is recorded, **Then** it is recorded exactly as it is for any ride, unaffected by this feature.

---

### User Story 7 - Driver views payment-model, subscription, and wallet status (Priority: P3)

A driver can see which payment model currently applies to them (and any pending change), their subscription status if applicable, and their Commission Wallet's current balance and full, unmodifiable transaction history if applicable.

**Why this priority**: Important for trust and transparency, but the system is financially sound and usable end-to-end (User Stories 1–6) without it.

**Independent Test**: Can be fully tested by performing a recharge and a ride commission deduction, then confirming the driver's wallet view shows the correct balance and both transactions in history, in order, without either being alterable.

**Acceptance Scenarios**:

1. **Given** a driver's current state, **When** they check their status, **Then** they see their current payment model, any pending change and when it takes effect, and — depending on the model — either their subscription status or their wallet balance and transaction history.
2. **Given** any past wallet transaction, **When** any party attempts to alter it, **Then** the system does not permit editing a historical transaction; corrections only ever appear as new, separate transactions.

---

### Edge Cases

- What happens when a commission-model ride's **stored commission amount** (determined once, at acceptance) is higher than the driver's **current wallet balance at completion** (e.g. balance ₹90, stored commission ₹100)? **Decision (reversed from an earlier draft of this spec)**: this is **not** handled by deducting a partial amount and recording a shortfall — that mechanism has been removed entirely. Instead, no deduction, wallet transaction, or ledger entry is created for that ride's commission at all; the condition is recorded for investigation/reconciliation as an exceptional, invariant-violation case, not a routine outcome (see FR-024, User Story 5a). This can only happen because the wallet balance changed between acceptance and completion (e.g. an admin adjustment) — never because the commission amount changed, since it is never recalculated.
- What happens if the customer's **final fare** is determined or confirmed at ride completion and differs from what was expected at acceptance? **Decision**: this has no effect on the ride's stored driver commission amount — customer final fare and driver ride commission are two separate values; only the former may be finalized at completion (see spec's "Important Distinction" note below FR-024c).
- What happens if the company's Commission Plan (rate/rule) changes **after** a ride has already been accepted, but before it completes? **Decision**: the already-accepted ride keeps using its own stored commission amount, determined at its own acceptance time, unaffected by the change; only rides accepted after the change use the new rate.
- What happens when a subscription-model driver's subscription **expires while a ride is already in progress**? **Decision**: an in-progress ride (already accepted before expiry) completes normally with no commission-wallet involvement; subscription expiry only prevents that driver from receiving or accepting _new_ rides going forward (see FR-004a).
- What happens when a subscription-model driver **changes plans** (e.g. Weekly → Monthly) or **cancels** their subscription? **Decision**: both take effect at the start of the _next_ billing period — the driver keeps the plan and access they already paid for through the current period's expiry date, with no proration or partial refund (see FR-006a).
- What happens when a driver **switches payment model** (`SUBSCRIPTION → COMMISSION` or `COMMISSION → SUBSCRIPTION`)? **Decision**: `COMMISSION → SUBSCRIPTION` takes effect immediately upon the new subscription's activation; `SUBSCRIPTION → COMMISSION` is staged to take effect at the current active subscription's expiry (no proration), or immediately if no subscription is currently active. In every case, a ride already accepted before the switch is processed exactly under the model that applied at its acceptance, never the driver's model at completion time (see FR-031).
- What happens if a driver's wallet recharge payment succeeds with the provider but the backend crashes or times out before recording it? The wallet must end up credited exactly once, never zero or twice, once the provider's confirmation is eventually processed.
- What happens if a driver cancels a commission-model ride **before** completion? No commission is ever deducted, since deduction only happens at completion and nothing was set aside beforehand to release.
- What happens if a refund is issued against a wallet recharge that has already been partially or fully spent on ride commissions?
- What happens when a driver has **no active subscription at all** (subscription-model, never subscribed, or subscription lapsed with no grace period remaining)? They must not be able to accept new rides.
- What happens when a subscription-model driver's **renewal payment fails**? The prior active subscription's expiry determines when ride eligibility is affected — see FR-004a/FR-006a; no grace period applies by default.
- What happens when a driver has **not yet selected any payment model**? They are not eligible for any ride under either model (see FR-000).
- What happens when the **customer's** ride payment fails or is refunded — does that ever reverse or alter the **driver's** commission wallet transaction for the same ride? It must not, per this feature's separation requirement (see FR-027).
- What happens when the company **deactivates a predefined recharge amount** a driver has used before? Past recharges are unaffected; the option simply stops being offered going forward.

## Requirements _(mandatory)_

### Functional Requirements

**Driver payment model**

- **FR-000**: System MUST record, per driver, exactly one currently-effective payment model — `SUBSCRIPTION` or `COMMISSION` — and MUST treat a driver with no model selected as ineligible for any ride under either model.
- **FR-000a**: System MUST allow a driver to select their payment model for the first time, effective immediately, and to request a change from their current model, effective per FR-031.
- **FR-031**: System MUST determine which payment model governed a specific ride from the model that was effective **at the moment that ride was accepted**, and MUST NOT change how an already-accepted ride is processed — at completion or otherwise — based on any subsequent change to the driver's payment model. A ride is never processed under two different models.

**Subscription plans and driver subscriptions (SUBSCRIPTION model only)**

- **FR-001**: System MUST allow the company to define subscription plans, each with a unique plan identifier, name, billing period (1-Day, Weekly, or Monthly), price, currency, and an active/inactive status.
- **FR-002**: System MUST allow a subscription-model driver to select an active plan and initiate payment for it through the company's existing payment collection mechanism.
- **FR-003**: System MUST activate a driver's subscription — recording the plan, start date, expiry date (derived from the plan's billing period), payment status, and renewal status — only after the plan payment is confirmed by the payment provider, never on a client-reported success alone.
- **FR-004**: System MUST treat "has an active, unexpired subscription" as a required precondition, alongside existing driver-eligibility checks (verification, suspension, availability), before a **subscription-model** driver can be offered or accept a **new** ride. This precondition MUST NOT be applied to a commission-model driver.
- **FR-004a**: System MUST NOT interrupt or block completion of a ride the driver was already assigned/had accepted before their subscription expired; that ride's lifecycle proceeds exactly as it would for a driver with an active subscription. Subscription status is evaluated only at new-ride offer/acceptance time, never mid-ride.
- **FR-005**: System MUST NOT activate or extend a subscription when the corresponding plan payment fails, is cancelled, or is not confirmed.
- **FR-006**: System MUST record, for every subscription period, whether it is set to auto-renew, and MUST make the outcome of each renewal attempt (success/failure) visible in the subscription's history.
- **FR-006a**: System MUST apply a driver-initiated plan change or subscription cancellation starting from the beginning of the next billing period; the driver retains their current plan's access through the already-paid-for period's expiry date, and no proration or partial refund is issued for the remainder of the current period.
- **FR-006b**: System MUST NOT require or check any Commission Wallet balance for a subscription-model driver's ride at any point — acceptance or completion.

**Driver Commission Wallet (COMMISSION model only)**

- **FR-007**: System MUST maintain exactly one Driver Commission Wallet per driver, distinct from that driver's earnings/payout balance, from their subscription record, and from any customer wallet.
- **FR-007a**: System MUST NOT require a subscription of any kind for a commission-model driver's ride eligibility.
- **FR-008**: System MUST allow a commission-model driver to initiate a manual recharge of their Commission Wallet through the company's payment collection mechanism, specifying either a custom amount or one of the company's configured predefined recharge amounts.
- **FR-008a**: System MUST validate a custom recharge amount against a company-configured minimum and maximum, and MUST validate a predefined-amount selection against the company's currently active list of predefined recharge amounts, before initiating payment.
- **FR-008b**: System MUST allow the company to configure the list of predefined recharge amounts (create, activate, deactivate); deactivating one MUST NOT alter any past recharge already made using it.
- **FR-009**: System MUST credit a wallet recharge only after independently verifying successful payment with the payment provider (e.g. via provider confirmation/webhook), and MUST NOT credit a wallet based solely on a claim made by the requesting client/app.
- **FR-010**: System MUST ensure a single confirmed recharge payment results in exactly one wallet credit, even if the provider's confirmation is delivered more than once or the recharge request is retried.
- **FR-012**: System MUST record every wallet balance change as an individual, permanent transaction carrying: a unique identifier, the driver, the related ride (when applicable), a reference to the originating operation, the amount, the balance before and after the change, the transaction type, its status, and when it was created.
- **FR-013**: System MUST NOT allow any wallet transaction, once recorded, to be edited or deleted; any correction MUST take the form of a new, separate transaction.

**Commission calculation (COMMISSION model only)**

- **FR-013a**: System MUST determine a commission-model ride's commission amount using the company's existing, already-configurable commission-rate mechanism (the existing pricing rule that already governs the rest of that ride's fare), distinct from a Subscription Plan and from the Wallet itself — not a newly invented calculation. See `decisions.md` BD-6 for the exact, evidence-based definition of what "how commission is calculated" already means in this system.
- **FR-013b**: System MUST determine a commission-model ride's commission amount **exactly once, at ride acceptance**, and MUST persist that amount on the ride, immutably, for the ride's lifetime. System MUST NOT determine or calculate a commission-model ride's commission a second time at any later point, including at ride completion. See `decisions.md` BD-7.

**Ride eligibility (COMMISSION model only — no reservation/freeze)**

- **FR-014**: System MUST determine the commission amount applicable to a ride and store it on the ride before that ride is assigned to or accepted by a commission-model driver, using the company's existing, already-configured commission rate mechanism for that ride (see FR-013a/FR-013b; `decisions.md` BD-6/BD-7) — not a newly invented formula, and not subject to later recalculation.
- **FR-015**: System MUST verify, using only its own stored record of the driver's wallet, that the driver's current balance is greater than or equal to the ride's determined (stored) commission amount before allowing that commission-model driver to be assigned or to accept the ride.
- **FR-016**: System MUST reject/block the ride assignment or acceptance for a commission-model driver whose wallet balance is less than the ride's determined commission amount.
- **FR-017**: System MUST NOT rely on a wallet balance value supplied by the requesting client, a cached value, or any value other than its own authoritative, current record when making the eligibility decision.
- **FR-017a**: System MUST NOT reserve, lock, freeze, or otherwise set aside any part of a commission-model driver's wallet balance at ride assignment/acceptance time. The eligibility check is a read-only comparison with no side effect on the wallet. (Determining and storing the ride's commission amount, per FR-014, is a write to the ride record, not a write to the wallet — it reserves nothing.)

**Ride completion and commission deduction (COMMISSION model only)**

- **FR-020**: System MUST use the commission amount already determined and stored on the ride at acceptance (FR-013b/FR-014) when processing a commission-model ride's completion. System MUST NOT recalculate commission at ride completion, regardless of what the ride's actual/final customer fare turns out to be.
- **FR-021**: System MUST verify, before deducting, that the stored commission amount for a given completed commission-model ride has not already been deducted, so that retried or duplicate completion processing never deducts commission twice for the same ride.
- **FR-022**: System MUST deduct the **full** commission amount already stored on the ride at acceptance (FR-020) from the driver's Commission Wallet — never a partial amount — under a database lock on the wallet row (for safe concurrent updating, not a business reservation), as part of one indivisible operation at ride completion, whenever the wallet's balance at that moment is sufficient to cover it in full. No reservation-release step is part of this operation, because none was created at acceptance, and no recalculation step is part of this operation either.
- **FR-023**: System MUST record the commission deduction as an immutable wallet transaction and MUST create the corresponding accounting/ledger entries crediting the company's commission account, such that the wallet deduction and its accounting entries either both persist or neither does.
- **FR-024**: When a commission-model ride's stored commission amount exceeds the driver's wallet balance available at completion, System MUST NOT deduct a partial amount, MUST NOT create a wallet transaction or ledger entry claiming any portion of the commission was collected, MUST NOT allow the wallet balance to go negative, and MUST NOT create a debt, receivable, or shortfall-balance record for the driver. System MUST instead treat this as an exceptional condition — distinct from ordinary business flow — and record it (driver, ride, stored commission amount, actual balance found) in a form usable for investigation and reconciliation. The ride's stored commission amount itself MUST NOT be altered.
- **FR-024e**: System MUST NOT reintroduce, under any name, a mechanism that deducts less than the ride's full stored commission amount and treats that as the commission having been collected for that ride. A commission-model ride's commission is either collected in full (FR-022) or not collected at all for that completion attempt (FR-024) — there is no third outcome.
- **FR-024a1**: System MUST NOT deduct a negative amount (i.e. MUST NOT credit the wallet) when a ride's determined commission amount is zero or negative; the deduction in that case is exactly zero.
- **FR-024b**: System MUST perform the commission deduction without depending on a live network call to an external payment provider as part of the same indivisible operation.
- **FR-024c**: System MUST NOT deduct any Commission Wallet amount for a ride whose pinned payment model (FR-031) is `SUBSCRIPTION`, and MUST NOT determine or store a commission amount for such a ride at all.
- **FR-024d**: System MUST treat a commission-model ride's determined commission amount and the ride's customer-facing final fare as two independent values. Determining or confirming the customer's final fare at ride completion MUST NOT read, write, or otherwise affect the ride's already-stored commission amount.

**Separation from other money flows**

- **FR-025**: System MUST keep the customer's ride payment flow (how the customer pays their fare) fully separate from the Driver Commission Wallet flow (how the driver funds and pays commission) — no operation in one flow may directly credit or debit the other.
- **FR-026**: System MUST keep the Driver Commission Wallet conceptually and operationally distinct from the driver's subscription record, from the driver's earnings/payout balance, and from any customer wallet, reusing existing distinctions already established in the system unless a specific requirement above states otherwise.
- **FR-027**: System MUST ensure a customer-side refund or payment failure on a ride does not, by itself, alter the driver's Commission Wallet transaction already recorded for that ride.

**Visibility and auditability**

- **FR-028**: System MUST allow a driver to view their current payment model, any pending change, and — depending on the model — their subscription status or their Commission Wallet's current balance and complete transaction history.
- **FR-029**: System MUST allow authorized staff to view a driver's payment model, subscription status, and Commission Wallet activity for support and audit purposes.
- **FR-030**: System MUST record, for any staff-initiated adjustment to a driver's Commission Wallet, who performed it and why, following the same accountability standard already applied to other financial adjustments in the system.

### Key Entities

- **Driver Payment Model**: The single, currently-effective classification of a driver as `SUBSCRIPTION` or `COMMISSION`, together with any pending change and when it takes effect.
- **Subscription Plan**: A company-defined offering a subscription-model driver can purchase for platform access. Carries a plan identifier, name, billing period (1-Day/Weekly/Monthly), price, currency, and status.
- **Driver Subscription**: One driver's purchased instance of a plan. Carries the driver, the plan, start date, expiry date, renewal status, and payment status; determines whether a subscription-model driver currently has ride eligibility. Represents the driver's selected ride-payment model for the active period — not a generic, separate "permission to work" concept layered on top of a different commission mechanism.
- **Commission Plan**: The company's existing, already-configurable rule that determines how commission is calculated for a ride (rate, effective period, and which ride it applies to) — reused, not reinvented, by this feature for commission-model drivers; distinct from a Subscription Plan (which governs access/price for the subscription model) and from the Driver Commission Wallet (which stores the money itself). See `decisions.md` BD-6.
- **Ride Commission Amount**: The specific commission amount determined, once, for a single commission-model ride, at the moment it is accepted, using the Commission Plan in force at that moment. Stored permanently on the ride. This is the sole authoritative figure used for the wallet-eligibility check at acceptance and the wallet deduction at completion — it is never recalculated, and is entirely independent of the ride's customer-facing final fare. See `decisions.md` BD-7.
- **Driver Commission Wallet**: A single per-driver store of funds a commission-model driver has deposited, used specifically to cover ride commission owed to the company. Carries a single balance and a currency — no locked/reserved portion.
- **Commission Wallet Transaction**: An immutable record of one balance-affecting event on a Driver Commission Wallet (recharge, commission deduction, refund, or administrative adjustment), carrying the amount and the balance before/after.
- **Wallet Recharge Option**: A company-configured predefined amount a driver may select when recharging, alongside the alternative of entering a custom amount within a configured range.
- **Company Commission Account**: The company's internal accounting destination that receives the credited side of every commission deduction.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of ride assignment/acceptance attempts for a commission-model driver whose wallet balance is below the ride's determined commission amount are rejected, verified against the system's own stored balance only.
- **SC-002**: 100% of commission deductions at ride completion are atomic, idempotent, and free of any recalculation — exactly one wallet transaction and one balanced ledger entry per commission-model ride whose wallet balance covers the stored amount, both equal in full to the amount determined and stored at acceptance (never a re-derived, capped, or partial figure), even under retried completion triggers.
- **SC-011**: 0% of commission deductions are partial. When a commission-model ride's stored commission amount is not fully covered by the driver's wallet balance at completion, exactly zero wallet transactions and zero ledger entries are created for that ride's commission — never a reduced-amount transaction, and never a false full-amount one.
- **SC-003**: 0% of Commission Wallet recharge credits occur without independent payment-provider confirmation; a client-only "success" report never results in a balance increase.
- **SC-004**: 100% of completed commission-model rides produce exactly one wallet debit transaction and one balanced accounting entry — never a debit without an entry, or an entry without a debit — and 0% of completed subscription-model rides produce any Commission Wallet activity at all.
- **SC-005**: 100% of duplicate payment-provider confirmations and duplicate ride-completion triggers for the same underlying event result in no additional wallet credit or debit beyond the first.
- **SC-006**: 100% of subscription-model drivers without a currently active subscription are excluded from receiving new ride offers; 100% of commission-model drivers are evaluated for ride offers with no subscription check at all.
- **SC-007**: Drivers can retrieve their current payment model, subscription status or wallet balance/history (as applicable), in a single request, with wallet history reflecting every prior transaction unaltered.
- **SC-008**: 100% of rides retain, at completion, the payment model that applied when they were accepted, regardless of any payment-model change the driver makes while the ride is in progress.
- **SC-009**: 100% of commission-model ride commission determinations use the company's existing, already-configured commission-rate mechanism for that specific ride — never a hardcoded, reinvented, or ride-inconsistent rate.
- **SC-010**: 100% of commission-model rides have their commission amount determined exactly once, at acceptance, and stored unchanged thereafter — no code path recalculates it at completion, and no change to the ride's customer-facing final fare ever alters it.

## Assumptions

- Subscription payment and Commission Wallet recharge are both processed through the company's existing payment gateway integration(s); this feature does not introduce a new payment gateway.
- The system operates in a single currency (INR) across subscription, wallet, and ride payment flows, consistent with the rest of the platform.
- The ride commission amount is derived from the same fare/commission calculation the platform already uses elsewhere for driver earnings (the existing per-vehicle-type/city pricing rule's commission rate, already versioned and already pinned per ride) — this feature does not introduce a second, competing commission-calculation engine, a new Commission Plan table, or per-driver differentiated rates unless explicitly confirmed as separate, additional scope. Minimum and maximum commission are not defined in the existing implementation and remain undefined by this feature (`decisions.md` BD-6).
- A commission-model ride's commission amount is determined exactly once, at acceptance, using the Commission Plan in force at that moment, and is never recalculated — not at completion, and not in response to any later change in the customer's final fare or in the company's Commission Plan (`decisions.md` BD-7). "Expected commission" and "final commission" are not two different values in this system; there is one determined, stored commission amount per commission-model ride.
- Existing customer ride payment, refund, driver settlement, and driver payout functionality continues to operate unchanged; this feature does not modify those flows.
- Staff/admin ability to view and adjust wallets is an extension of the accountability and audit pattern already used for other financial adjustments in the system, not a new authorization model.
- A driver has at most one Driver Commission Wallet and at most one active Driver Subscription at any given time, and exactly one effective payment model at any given time.
- A driver must actively select a payment model before being eligible for any ride; no default model is silently assigned.
- No reservation, hold, or locked-balance concept exists anywhere in this feature — the platform's pre-existing rule that a driver can have at most one active ride at a time is relied upon (not re-implemented by this feature) to make such a mechanism unnecessary; see `revision-002-dual-model.md` §10 for the full reasoning.
- No partial commission collection, capped deduction, or shortfall/debt/receivable concept exists anywhere in this feature. A commission-model ride's commission at completion is collected in full or not at all; an insufficient wallet balance at that moment is an exceptional condition logged for investigation, never a routine, silently-handled shortfall (`decisions.md` BD-1, reversed).
