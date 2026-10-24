---
description: 'Implementation tasks for Production-Ready Razorpay Payments for Drivers'
---

# Tasks: Production-Ready Razorpay Payments for Drivers

**Input**: [plan.md](./plan.md) · [spec.md](./spec.md) · [decisions.md](./decisions.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Revised**: 2026-10-19 (second review). This version adds the tasks that plan.md already cited but this file lacked: T006, T007, T020b, T026, T027, T028, T035, T037, T038, T066–T068, T087 and T095–T098. It also adds priorities, prerequisites, completion criteria and test-matrix links (TM-xx, defined in [quickstart.md](./quickstart.md#test-matrix)). It corrects T004, T020, T022, T024 and T042 to match decisions.md.

**Third review (2026-10-19)**: adds T008 (written questions to Razorpay) and T039 (UD-10 payload policy). It tags the subscription-wave tasks `[SUB]`, makes the kill switch per purpose (T035, T052, T055), and corrects T003, T004, T007, T013, T014, T037, T053, T060, T061, T065, T080, T081 and T100–T105. Every blocker in [plan.md → Master blocker register](./plan.md#master-blocker-register) maps to tasks here.

**Fourth review (2026-10-19)**:

- Adds T042b (only if TD-1b, needs UD-12) and T099 (alert rules, MI-12).
- Tightens T014, T022, T026, T028, T043, T046, T051, T052, T066, T067, T080, T085, T087 and T103 to close DOC-13…DOC-19.
- The pre-live set rule is unchanged; T099 is P1, so it is in it. T042b is in it only if TD-1b is selected.

**Prerequisites** (state on 2026-10-19 — nothing is implemented):

- Constitution v1.0.0 is ratified. Amendment AM-1 is written by T001 only after the owner approves its text (UD-3).
- D-1, D-5 and D-10 are approved (Owner). D-2, D-3, D-4, D-6, D-7 and D-11 are owner-approved, **Finance confirmation pending**.
- UD-1 (was DR-1), UD-2 (was TD-14) and UD-3…UD-10 are **open** ([decisions.md §2](./decisions.md#2-unresolved-decisions)). A task that depends on one names it under "Needs" and does not start before it is decided.

**Priorities**:

- **P0**: financial-integrity or security blocker. No live payment until done.
- **P1**: required for the controlled pilot (gates G4–G8).
- **P2**: required before expanding beyond the pilot.
- **P3**: hygiene.
- **`[SUB]`**: subscription wave (wave S). Not needed for the recharge pilot. It ships behind `payments.subscription_checkout` after its own gates (plan.md → Release scope).

**Pre-live set**: every P0 and P1 task not tagged `[SUB]`, except T105 (the pilot itself) and T106. No live payment until all of them are done and gates G0–G7 are signed. A task is done only when its "Done when" evidence exists; a checked box without that evidence does not count.

**Completion rule (every task)**: the task's tests pass twice in a row on an isolated database; `npm run typecheck` and `npm run lint` are clean in the touched repository (admin: `npm run type-check` and `npm run lint`); no test was weakened (constitution §15.3); nothing outside the listed files changed. "Done when" adds what is specific to the task.

**Tests**: **Required**, because this feature moves money (constitution §14, §15). Test tasks come first and must fail before the implementation task they cover.

**Repositories**: `back/` = `zaroorat-back/`, `app/` = `zaroorat_driver_production_app/`, `admin/` = `zaroorat-admin-panel/`.

**Working-tree caution**: other teams' uncommitted work exists in all three repositories (Google Maps, branding, driver tabs, navigation). The file-level overlap table is in [plan.md](./plan.md#files-shared-with-other-in-progress-work-coordinate-before-editing--t006). No task starts on an overlapping file until T006 has recorded who coordinates it. Never revert, reformat or stage someone else's change.

## Format: `[ID] [P?] [Story] Priority — Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1…US6 from spec.md
- **Needs**: tasks or decisions that must be complete first
- **Done when**: completion criteria beyond the completion rule

---

## Phase 1: Setup and gates (no production code)

**Purpose**: settle the facts and decisions the design depends on. Gates G0–G2.

- [ ] T001 **P0** — Write amendment AM-1 into `back/.specify/memory/constitution.md` §9.4, using the exact text in decisions.md §3. Bump the version to 1.1.0 and set Last Amended to the approval date.
  - Needs: UD-3 approved (**done 2026-10-20**, Owner) and this task's own authorization (not yet given).
  - Done when: the §9.4 text matches decisions.md verbatim; a reviewer other than the author confirms.
- [ ] T002 **P0** — Owner: create the Razorpay **test** key pair and a test-mode webhook to staging `/api/v1/payments/webhooks/razorpay` with the six events in `contracts/razorpay-provider.md`. Set the webhook alert email to on-call. Store keys and secret in staging config only (D-8).
  - Done when: a test delivery reaches staging and is answered 200; the keys exist in no other environment and in no repository.
  - **C6 (Owner, 2026-10-21)**: real sandbox webhook evidence comes from this HTTPS staging endpoint. No tunnel, and no exposed local development server, without explicit Owner approval.
- [ ] T003 **P0** — Run sandbox checks S1, S2, S3, S3b, S9, S11 and S13 from quickstart.md against test mode. Record each in the research.md Verification log.
  - Needs: T002.
  - Done when:
    - each row has date, action, observed response excerpt (no secrets, no PII) and conclusion;
    - U4, U5 and U8 are closed or escalated, and U3 and U9 are recorded;
    - S11 shows one refund for repeated identical requests;
    - any contradiction with `contracts/razorpay-provider.md` is corrected there before T016 starts.
- [ ] T004 **P0** — Operator: run read-only checks Q1–Q11 from data-model.md §12 on dev, staging and production (D-9).
  - Done when:
    - counts per environment are in research.md;
    - every non-zero Q1–Q9 has a Finance-approved remediation recorded;
    - Q10 shows the runtime role in staging and production, or SEC-7 is escalated;
    - Q11 records the active gateway and the `razorpay` intent count, is used to size T061's first runs, and decides whether T035 must ship ahead of everything else.
- [ ] T005 **P0** — Mobile spike in a throwaway branch of `app/`:
  - `npx expo install react-native-razorpay` (3.0.0 or later) and a minimal config plugin;
  - an EAS **development** build and an EAS **release** build (proguard) on a real Android device;
  - record success, failure, dismiss and network-loss callbacks (fields and error codes), UPI app visibility, and behaviour when the app is killed during checkout.
  - Needs: T002.
  - Done when: U1 and U2 are closed in research.md; TD-1 or TD-1b is selected and recorded in decisions.md with the date; nothing from the spike is merged.
  - **C2 (Owner, 2026-10-21)**: compatibility is judged against the app's actual Expo SDK, React Native version and New Architecture setting. **No automatic TD-1b fallback.** If the native SDK is incompatible, stop and present the evidence and options to the Owner. TD-1b then needs that explicit decision **and** UD-12 before any implementation.
- [ ] T006 **P0** — Overlap coordination. For each file in plan.md's overlap table, record the owner of the other change and the agreed order (merge first, or edit after rebase).
  - Done when: every overlapping task (T017, T031, T033, T035, T037, T050, T061, T082, T089, T090–T098) has a named coordinator in plan.md.
  - **Phase 1 portion recorded 2026-10-19** (plan.md → T006 record): T017 and T035 were implemented without touching any shared file, so they needed no coordinator. Coordinators for the later-phase rows: Owner proposed, **not yet confirmed**. The task stays open.
  - **2026-10-21 (Phase 3A)**: full coordination record in plan.md. It covers state, boundary, reviewer and sequencing for every shared file of T031, T033, T061, T082, the app tasks and the admin pages. **Still open**: nine technical owners marked "Owner to name", and the Owner's confirmation of the review rule.
- [ ] T007 **P0** — Decision record. Collect, with name, role and date in decisions.md, every decision G0 needs:
  - Finance: confirmation of D-2, D-3, D-4, D-6, D-7, D-11; UD-1 (with Owner); UD-2, including the refund legs for held money;
  - Owner: UD-3, UD-4, UD-10 (with Finance);
  - Owner + Finance: UD-6; UD-7, including how an `EXTERNAL_REFUND` case is resolved;
  - Finance + Engineering: UD-8, only if Q4 > 0.
  - Not required: UD-5 (current behaviour kept) and UD-9 (prefill stays omitted unless the Owner decides).
  - Done when: the G0 row of plan.md can be signed. An unapproved item stays open; it is never marked approved by Engineering, and an Engineering recommendation is not an approval.
- [ ] T008 **P2** — Owner (account holder): ask Razorpay support in writing about:
  - U5: whether a second capture is possible on a paid order through late authorisation;
  - U6: whether standard orders expire;
  - U7: how long a refund idempotency key stays valid;
  - U9: whether one repeatedly failing event can get the webhook disabled.
  - TD-3 (Owner decision 2026-10-21): whether `POST /v1/orders` supports an idempotency key or another documented duplicate-order protection, and whether live mode enforces receipt uniqueness (test mode did not, S2c).
  - Done when: the replies, or "no answer" by the gate named in research.md, are recorded in the verification log. Nothing in the design waits on the answers: A7, A4, T087 and TD-15a hold whatever the replies say.

**Checkpoint (G0–G2)**: T001–T007 recorded. TD-1 or TD-1b selected. Data checks clean or remediation approved.

---

## Phase 2: Foundational — backend payment correctness (blocks every user story)

**Purpose**: make "one captured Razorpay payment → exactly one effect, or a tracked review" true before any driver can pay.

### Tests first

> **Phase 1 status (2026-10-20, uncommitted working tree).** T010–T014, T017, T027 and T035 were implemented under the Owner's limited Phase 1 authorization. Evidence, all run locally:
>
> - full unit suite: 2,059 tests, 2,013 pass, 41 todo (the new tests-first cases), 5 fail, all pre-existing. The 5 are: `verification-gate` and `queue configuration` (known); `rides/dispatch-counters-and-limits`, which fails identically at clean HEAD;
> - changed unit files: 104 tests, 63 pass, 41 todo, 0 fail, twice;
> - new integration suite `payment-kill-switch.test.ts`: 7 of 7, three runs, on an isolated clone of `zaroorat_test` that has since been dropped;
> - `npm run typecheck` exit 0. ESLint and Prettier are clean on every changed file. Repository-wide `npm run lint` has 1 error, in `app-config.controller.ts:42`, someone else's uncommitted file.
>
> A checked box here does **not** resolve a blocker: plan.md's register still needs G3 (CI twice + an independent reviewer).

> **Phase 2 status (2026-10-21, uncommitted working tree, awaiting Owner review).** Authorized 2026-10-20 (Option A): T003, T015, T016, T019–T024, plus only the T031 parser fields T024 needs. Boxes stay unchecked until each "Done when" is met.
>
> - **T003**: S1, S2, S3, S3b, S9, S11 run in test mode on 2026-10-20 (research.md Verification log). Contract corrected before T016 (duplicate-receipt recovery withdrawn, TD-3 open). S13 was not authorized.
> - **T015**: done, with one deviation: `findOrderByReceipt` was not added, because nothing calls it once TD-3's recovery was withdrawn (contract §4). `listPayments` is kept for T067.
> - **T016**: done. Receipt `zr1_`+32 hex, `partial_payment: false`, notes `{purpose, driver_ref}`, `confirmIntent`/`fetchOrderPayments` on `GET /orders/{id}/payments`; the T016 grep is empty. T010, T011 and T013 pass; T013's four receipt-lookup cases stay `todo` (TD-3 pending Owner).
> - **T019**: partly done. `PaymentReviewCase`, `PaymentReconciliationRun` and their relations are in. **Deferred**: `payment_intents.last_reconciled_at` and the four `gateway_events` columns. Adding them to the Prisma model breaks every `payment_intents`/`gateway_events` query on an unmigrated database (the shared dev DB and `zaroorat_test`, which this authorization does not allow migrating). Nothing in this scope reads them; they belong with T026/T031 and intent reconciliation.
> - **T020**: migration `20261021120000_razorpay_payment_safeguards` applied **only** to the disposable `zaroorat_rzp005_test` (template clone of `zaroorat_test`; Q1/Q3/Q4/Q9 = 0 there). No `CHECK (balance >= 0)` (D-2 open → T020b); the T019 columns above are not included. The schema-vs-database diff is empty for the new objects. Not met: "applies on a copy of staging data" and "previous app version's suite against the migrated schema".
> - **T021**: setting added. Its done-when needs T018, which was not authorized.
> - **T022**: `payment-review-cases.test.ts`, 10/10, twice. UD-2 open, so the "no ledger group, the case reports the gap" branch is the one tested.
> - **T023**: done; registered as `paymentReviewCaseRepository`.
> - **T024**: gate `payment-application-rules.ts` + `applyConfirmation(intentId, provider, path, tx)`. T012 25/25 pass. Choices for review:
>   - (a) ~~`ORDER_MISMATCH` opens a case without a hold row~~ **Superseded by decision R1 (decisions.md §2b, 2026-10-21) and implemented in R1-T**: an order mismatch is rejected before the gate, the claiming intent does not change, and the payment is routed to the intent that owns its order or opens `UNKNOWN_ORDER`. `ORDER_MISMATCH` stays a reserved kind in the database constraint.
>   - (b) `EXTERNAL_REFUND` does not change the intent status (data-model §2 lists no A10 move).
>   - (c) A further matching capture on a `MANUAL_REVIEW` intent opens `MULTIPLE_CAPTURES` and leaves the intent in review.
>   - (d) `PAYMENT_SUSPENSE` is not added to `LEDGER_ACCOUNTS` until UD-2.
>   - (e) A signed webhook with a missing or malformed amount, currency, status or `order.paid` `amount_paid` applies nothing and opens no case; reconciliation settles it.
>   - (f) Historical SUCCEEDED rows that store an order id (UD-8) cannot match A11, so a redelivered capture for such an intent opens `MULTIPLE_CAPTURES` instead of being a no-op. Q4 sizes this.
> - Existing tests adapted, no assertion loosened. Webhook fixtures now carry the real order id, `amount` and `currency`, through the `capturedPaymentFields` helper. The h1 mock patches moved to `fetchOrderPayments`. The `payment-reconciliation` backdating fixture lifts the new append-only trigger inside its own transaction.
> - Found, not fixed (outside this scope): `authorization-bola` still expects 403 from confirm, where T027 (Phase 1) now answers 404 by design.

- [x] T010 [P] **P0** — Unit tests for the provider-truth function in `back/tests/unit/payments/razorpay-provider-truth.test.ts`:
  - calls `GET /v1/orders/{id}/payments`, never `/v1/payments?order_id=`;
  - ignores items for other orders;
  - `captured` vs `authorized` vs `failed` vs empty;
  - multiple captures;
  - returns the `pay_…` id.
  - Done when: TM-01 fails against today's `confirmIntent`.
- [x] T011 [P] **P0** — Update `back/tests/unit/payments/gateway-adapters.test.ts`: replace the `/payments?order_id=` assertion with the documented endpoint; add a mocked response containing another order's captured payment, which must not be selected (TM-01).
  - **Phase 1 note**: the two new cases were added as `todo`. The existing `/payments?order_id=` assertion stays until T016, which removes it in the same change that makes the new cases pass, so no passing test was weakened before its replacement existed.
- [x] T012 [P] **P0** — Unit tests for the validation gate in `back/tests/unit/payments/payment-validation-gate.test.ts`:
  - every rule A1–A12 and the evaluation order in spec.md;
  - **R1 (2026-10-21)**: the two A5 order-mismatch cases assert the decided behaviour, `REJECT` with no review kind and no status change. The original expectation (review + `MANUAL_REVIEW`) predates R1.
  - amount ±1 paisa; currency; `authorized`;
  - reused payment id (A6) and multiple captures (A7) on a SUCCEEDED intent: the intent stays SUCCEEDED;
  - provider timeout → unknown, no state change;
  - allowed and forbidden source statuses per data-model.md §2.
  - Done when: TM-02 covers each row of the rules table at least once.
- [x] T013 [P] **P0** — Unit tests for the deterministic receipt in `back/tests/unit/payments/razorpay-receipt.test.ts`:
  - ≤ 40 ASCII chars for subscription and recharge keys;
  - same key → same receipt; different key → different receipt;
  - any 400 → `GET /v1/orders?receipt=` → reuse only a single order with matching amount and currency; otherwise `PAYMENT_GATEWAY_UNAVAILABLE`;
  - `partial_payment: false` is sent;
  - 100,000 distinct scoped keys produce 100,000 distinct receipts.
  - Covers TM-03.
- [x] T014 [P] **P0** — Extend `back/tests/unit/payments/idempotency-required.test.ts` and `back/tests/unit/core/idempotency-store.test.ts` (TM-04):
  - recharge keys are stored scoped `recharge:{driverId}:{key}`;
  - two drivers sending the same raw key get two separate intents and orders, and neither response contains the other's intent or order id;
  - the defensive owner check: a found intent owned by another user → `409 DUPLICATE_IDEMPOTENCY_KEY` with no intent data, plus a security log line;
  - one driver using the same raw key for a recharge and then a subscription gets two separate intents (the purpose prefix keeps them apart);
  - the in-flight marker expires after `PAYMENT_IDEMPOTENCY_INFLIGHT_TTL_SEC`, while the result TTL stays 24 h.

### Implementation

- [ ] T015 **P0** — Extend the provider interface in `back/src/modules/payments/services/gateway/gateway.provider.ts`:
  - add `fetchOrderPayments(orderId)`, `fetchPayment(paymentId)`, `findOrderByReceipt(receipt)` and `listPayments(from, to, skip)`, returning the normalised shapes in `contracts/razorpay-provider.md`;
  - implement them in `mock.gateway.ts` and in `back/src/integrations/stripe/stripe.client.ts` (dormant; equivalent PaymentIntent lookups).
  - Needs: T003.
- [ ] T016 **P0** — In `back/src/integrations/razorpay/razorpay.client.ts`, implement:
  - provider truth;
  - the deterministic receipt (TD-3) and the 400 → lookup recovery;
  - `partial_payment: false`;
  - `notes` per contract (no `userId`).

  `confirmIntent` delegates to `fetchOrderPayments` and returns the `pay_…` id.
  - Needs: T015.
  - Done when: T010, T011 and T013 pass; `grep -n "payments?order_id" back/src` is empty.

- [x] T017 **P0** — Scope recharge keys (TD-6):
  - in `back/src/modules/payments/controllers/commission-wallet.controller.ts`;
  - in `IntentService.createIntent` (`back/src/modules/payments/services/intent/intent.service.ts`), the replay lookup also compares `userId`;
  - add the in-flight TTL to `back/src/core/cache/stores/IdempotencyStore.ts`;
  - add `PAYMENT_IDEMPOTENCY_INFLIGHT_TTL_SEC` via `numericEnv` in `back/src/config/payment/payment.config.ts` and `back/.env.example`.
  - Needs: T006 (`.env.example`).
  - Done when: T014 passes.
  - **Ordering rule found in Phase 1 (K-19)**: scoped recharge keys are longer than Razorpay's 40-character receipt limit until T016 hashes the receipt. T017 is safe only while both payment switches are OFF; T016 must ship before either switch is turned on with the Razorpay gateway.

### Database (after T004)

- [ ] T018 [P] **P0** — Integration test `back/tests/integration/financial-constraints.test.ts` (TM-05):
  - each partial unique index rejects a second row, and the review-case unique rejects a second case;
  - `balance < 0` is refused (only once D-2 is confirmed; otherwise the case is skipped with a visible reason and enabled in T020b);
  - UPDATE, DELETE and TRUNCATE on `payment_ledger_entries` and `driver_commission_wallet_transactions` are refused;
  - when `zaroorat_app_runtime` exists, it lacks UPDATE, DELETE and TRUNCATE on both tables (`has_table_privilege`);
  - the harness TRUNCATE reset still works.
- [ ] T019 **P0** — In `back/prisma/schema/modules/payment/payment.prisma`:
  - add models `PaymentReviewCase` and `PaymentReconciliationRun`;
  - add columns `payment_intents.last_reconciled_at` and `gateway_events.{outcome, processing_attempts, last_error, last_attempt_at}`;
  - add relations from `PaymentIntent`, `PaymentTransaction` and `Refund`;
  - run `npm run prisma:format` and `npm run prisma:validate`.
- [ ] T020 **P0** — Migration `back/prisma/migrations/<timestamp>_razorpay_payment_safeguards/migration.sql` per data-model.md §3–§8:
  - the new tables and columns;
  - the four partial unique indexes: `payment_intents (gateway, gateway_intent_id)`, `payment_transactions_provider_payment_key`, `payment_transactions_one_success_per_intent` and `commission_wallet_one_credit_per_intent`;
  - the review-case unique `(kind, provider_payment_id)`;
  - append-only and truncate-guard triggers with `ENABLE ALWAYS`;
  - the guarded `REVOKE … FROM zaroorat_app_runtime`;
  - `CHECK (balance >= 0)` **only if D-2 is confirmed by then**;
  - a header comment listing pre-checks Q1–Q9 and the `CONCURRENTLY` instructions (constitution §3.4).
  - Needs: T004 clean on the target environment, T019.
  - Done when: the migration applies on a copy of staging data; the previous app version's test suite still passes against the migrated schema.
- [ ] T020b **P0** — Follow-up migration adding `driver_commission_wallets_balance_non_negative`, if T020 shipped without it.
  - Needs: D-2 Finance confirmation, Q5 = 0.
  - Done when: the T018 balance case is enabled and passes.
- [ ] T021 **P0** — Set `zaroorat.allow_financial_truncate` alongside the existing audit setting in the reset of `back/tests/integration/helpers/harness.ts`.
  - Done when: T018 passes and the full integration suite still resets.

### Validation gate, review cases, failure persistence

- [ ] T022 [P] **P0** — Integration test `back/tests/integration/payment-review-cases.test.ts` (TM-06):
  - a signed webhook with amount −1 paisa → intent `MANUAL_REVIEW`, one `CAPTURED_REVIEW` row, one review case, no wallet credit, no subscription event;
  - a ledger group `GATEWAY_CLEARING DR / PAYMENT_SUSPENSE CR` **only if UD-2 is approved**; otherwise no ledger group, and the case reports the gap;
  - redelivery → still one case;
  - A6 on a SUCCEEDED intent → case without a hold row; the intent stays SUCCEEDED;
  - an `order.paid` whose `payload.order.entity.amount_paid` differs from the expected paise → `AMOUNT_MISMATCH` case, no credit.
- [ ] T023 [P] **P0** — Create `back/src/modules/payments/repositories/payment-review-case.repository.ts` and register it in `back/src/modules/payments/index.ts`:
  - `openIfAbsent` with `ON CONFLICT DO NOTHING`;
  - `listOpen`, `findById`;
  - a conditional `claimResolution`.
- [ ] T024 **P0** — Implement the validation gate (spec rules, evaluation order) inside `IntentService.applyConfirmation` in `back/src/modules/payments/services/intent/intent.service.ts`:
  - it accepts a normalised provider payment instead of a status string;
  - new statuses `EXPIRED` and `MANUAL_REVIEW`, and the transition table in data-model.md §2;
  - always store `pay_…` as `gatewayTxnId`;
  - on mismatch, write the hold row (except A6), open the case via T023 and emit `payment_amount_mismatch_total{kind}`;
  - emit the FR-035 audit log line;
  - add `PAYMENT_SUSPENSE` to `LEDGER_ACCOUNTS` (`back/src/modules/payments/constants/payment.constants.ts`) and post to it **only if UD-2 is approved**.
  - Needs: T012, T020, T023.
  - Done when: T012 and T022 pass.
- [ ] T025 [P] **P0** — Integration test `back/tests/integration/payment-provider-truth.test.ts` (TM-07):
  - the reconciliation job and `POST /payments/intents/:id/confirm`, with a stubbed provider returning another order's captured payment → no credit;
  - with the correct payment → one credit and `pay_…` stored, and then a refund of it is accepted.
- [ ] T026 **P0** — Webhook failure persistence and parking (FR-032, FR-034, TD-15, TD-15a), in `back/src/modules/payments/services/webhook/webhook.service.ts` and `back/src/modules/payments/repositories/webhook.repository.ts`:
  - on error, a separate transaction upserts `PROCESSING_FAILED` with an atomic `processing_attempts = processing_attempts + 1` (concurrent failures never lose a count) and a sanitised error, and the endpoint answers 5xx;
  - at `RAZORPAY_WEBHOOK_MAX_PROCESSING_ATTEMPTS`, the event becomes `PARKED`, answered 200, with an alert metric.
  - Tests in `back/tests/integration/payment-webhook.test.ts` (TM-10): a failure leaves a row; the next delivery reprocesses; the fifth failure parks; reconciliation then applies the payment once.
  - Needs: T020.
- [x] T027 **P0** — Harden the existing `POST /payments/intents/:intentId/confirm` (CD-15):
  - a UUID param schema in `back/src/modules/payments/routes/payment.routes.ts`;
  - `404 PAYMENT_NOT_FOUND` for a caller who is neither owner nor staff, in `back/src/modules/payments/controllers/intent.controller.ts` (do not change `assertOwnerOrStaff`, which other modules use).
  - Tests in `back/tests/integration/payment-checkout-flow.test.ts` (TM-16): other user → 404 with the same body as a missing intent; non-UUID → 400.
- [ ] T028 **P0** — Concurrency test `back/tests/integration/payment-exactly-once.test.ts` (TM-08):
  - for one captured payment, 10 truly concurrent attempts mixing verify, `payment.captured`, `order.paid`, intent reconciliation and the sweep;
  - assert exactly one SUCCEEDED row, one `MANUAL_RECHARGE`, one ledger group, one outbox event and the correct balance; every ledger group in the database balances (Q8 = 0);
  - a second variant inserts a duplicate SUCCEEDED row directly, inside a transaction that has already credited the wallet, and asserts the whole transaction rolls back.
  - Needs: T024.

### Webhook policy (D-1, AM-1)

- [ ] T030 **P0** — Rewrite the replay test in `back/tests/integration/payment-webhook.test.ts` per AM-1 (TM-09). It must assert:
  - a signed event 24 h old is applied once;
  - a duplicate of a processed event older than 5 min → `200 isDuplicate`;
  - an event older than 72 h → `200 TOO_OLD`, stored with `processed=true`, no effect;
  - payloads carry `amount`/`currency`;
  - a header-swapped replay causes no second effect;
  - two simultaneous deliveries of one event → one effect, and neither answer is 5xx.

  Extend `back/tests/unit/payments/webhook-security.test.ts`: a Stripe event with an old `created` but a fresh signed `t=` is accepted.
  - Needs: T001.

- [ ] T031 **P0** — Implement in `webhook.service.ts`, `webhook.repository.ts` and `back/src/modules/payments/utils/webhook-payload-parser.ts`:
  - dedupe before the age check (`processed = true` only);
  - `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE`;
  - Razorpay max age from `RAZORPAY_WEBHOOK_MAX_AGE_SEC`;
  - the `gateway_events.outcome` values;
  - read `amount`, `currency` and `amount_paid`;
  - Stripe freshness from the signed header only;
  - payload storage per UD-10 (until decided, unchanged).

  Add the knobs to `back/src/config/payment/payment.config.ts` and `back/.env.example`.
  - Needs: T001, T006, T026.
  - Done when: T030 passes.

- [ ] T032 **P0** — Out-of-order handling in `intent.service.ts`:
  - downgrades from SUCCEEDED → `STALE_IGNORED`, no throw, metric;
  - a late success on EXPIRED → applied and alerted;
  - a capture on CANCELLED → review `UNMATCHED_CAPTURE`.

  Tests in `back/tests/integration/payment-webhook.test.ts` (TM-11): captured-then-failed; expired-then-captured; `payment.failed` arriving before `payment.captured` for the same payment.

- [ ] T033 **P1** — Dual-secret verification during rotation (FR-024, window 24–72 h):
  - `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` / `_UNTIL` in `payment.config.ts`;
  - an optional previous-secret field in `back/src/modules/admin/system-settings/integrations/services/admin-payment-settings.service.ts`;
  - resolver support in `back/src/modules/payments/services/gateway/payment-gateway-resolver.service.ts`;
  - verify against both in `webhook.service.ts`.
  - Tests in `back/tests/unit/payments/webhook.test.ts` (TM-12): old secret accepted before `_UNTIL`, rejected after; `_UNTIL` < 24 h or > 72 h ahead is refused at config load.
  - Needs: T006.
- [ ] T034 **P1** — Observability (TM-13):
  - log every webhook rejection below 500, with no body and no signature (`back/src/modules/payments/schemas/error-response.ts`);
  - add `webhook_failure_total{reason=invalid_transition}`, `webhook_parked_total`, `payment_reconciliation_error_total` and `payment_amount_mismatch_total` in `back/src/modules/payments/metrics/payment.metrics.ts`;
  - extend `back/tests/unit/core/log-redaction.test.ts` to assert no payload, VPA, email or contact leaks.

### Operational controls

- [x] T035 **P0** — Per-purpose kill switch (TD-12):
  - an optional `defaultStatus` on seed entries in `back/src/modules/admin/system-settings/platform/constants/platform-settings.constants.ts`, used by `ensureSeeded` in `feature-flag.service.ts`;
  - `payments.driver_checkout` and `payments.subscription_checkout` are seeded **OFF**; `payments.pilot_mode` is seeded **ON**;
  - `IntentService.createIntent` checks the flag for the intent's purpose and refuses while it is off (`503 PAYMENTS_UNAVAILABLE`); existing intents still confirm.
  - This task may be deployed **on its own, ahead of every other task**, as the interim stop for CD-17: with both flags off, no app version can create an intent or a Razorpay order.
  - Tests (TM-14): a fresh database has both payment flags OFF and pilot mode ON; turning one payment flag on allows only that purpose; an already-seeded flag keeps its status on re-seed.
  - Needs: T006 (this constants file has uncommitted branding changes).
  - **Phase 1 implementation notes**:
    - The seeds live in a new file, `platform/constants/payment-feature-flags.constants.ts`, so the shared constants file was not edited (T006).
    - `IntentService.assertCheckoutOpen(purpose)` is the single check, called by `createIntent` and by the subscription purchase before its first write. Plan-change staging for an active subscriber is not gated.
    - Both route error handlers now return the 503 instead of their generic 500.
    - The integration harness switches both flags ON in `resetState()`.
    - `payments.pilot_mode` is seeded ON, but nothing enforces it until T037. The two OFF switches are the control meanwhile.
- [ ] T037 **P1** — Pilot allowlist (TD-19), in the form UD-4 decides: a system setting, **empty by default**, checked in `createIntent` for both purposes while `payments.pilot_mode` is on.
  - Tests (TM-14): with pilot mode on and an empty allowlist, nobody can create an intent even with a payment flag on; a listed driver can; with pilot mode off, the allowlist is ignored.
  - Needs: UD-4, T035.
- [ ] T038 **P0** — Job runs and heartbeats (TD-18, FR-033):
  - `back/src/modules/payments/repositories/payment-reconciliation-run.repository.ts`, written by every payment job (intent, subscription, sweep, wallet, refund reconciliation): start row, terminal update, counts;
  - gauge `payment_job_last_success_timestamp_seconds{job}`;
  - the "older than 2 × interval" alert rule documented in quickstart.
  - Tests in `back/tests/unit/jobs/payment-schedules.test.ts` (TM-15): every wave-R payment job is registered and writes a run, and a failed run records a sanitised error.
- [ ] T039 **P1** — Apply the UD-10 payload policy (CD-18, SEC-8), in `webhook.service.ts` and `webhook.repository.ts`:
  - store exactly what UD-10 allows (recommended: a sanitised projection, no signature);
  - apply UD-10's retention to rows already stored, as a separate, reviewed data step (no migration rewrites financial rows);
  - confirm that no API returns `gateway_events.payload` (today only the repository reads it).
  - Needs: UD-10.
  - Done when: TM-34 shows a stored test event contains no `email`, `contact`, `vpa` or `card` fields (or exactly the set UD-10 allows); the retention step is proven on a staging copy.

**Checkpoint (G3)**: TM-01…TM-15 green twice in CI on an isolated database. Fixes for CD-1, CD-2, CD-3, CD-4, CD-5, CD-6, CD-7, CD-8, CD-9, CD-15 and CD-20 merged with passing tests. They are marked resolved only in plan.md's register, with the evidence linked.

---

## Phase 3: User Story 1 — Driver recharges the commission wallet (Priority: P1) 🎯 MVP

**Goal**: a commission driver pays from the app with Razorpay Standard Checkout and sees the balance only after the backend confirms.

**Independent test**: TM-16…TM-21 (quickstart S5, S5b, S5c, S6 on a real device in test mode).

### Tests first

- [ ] T040 [P] [US1] **P0** — Integration test `back/tests/integration/payment-checkout-flow.test.ts` (TM-16):
  - the recharge response contains `checkout` with `keyId`, no secret and no `prefill`;
  - `POST /payments/intents/:id/verify` with a valid signature and a stubbed captured payment → `SUCCEEDED` and one credit;
  - an invalid signature → `400 PAYMENT_SIGNATURE_INVALID`, no provider call, no change;
  - an order mismatch → `400 PAYMENT_ORDER_MISMATCH`;
  - `GET /payments/intents/:id` for the owner vs another user (404 with an identical body);
  - flag off → `503 PAYMENTS_UNAVAILABLE`.
- [ ] T041 [P] [US1] **P1** — App unit tests (TM-17):
  - `app/src/services/payments/__tests__/attemptStore.test.ts`: save, resume and clear; key reuse per attempt; one attempt per purpose;
  - `app/src/services/payments/__tests__/paymentStatus.test.ts`: polling 2 s → 10 s, stops at a terminal status, maximum 2 min, then "We're checking your payment";
  - `app/src/features/billing/__tests__/walletTxnMapping.test.ts`: signs for REFUND, REFUND_REVERSAL and RIDE_COMMISSION.

### Backend

> **Backend status (2026-10-22, uncommitted, boxes stay unchecked):**
>
> - **R1-T** (decision R1): the Razorpay webhook no longer matches an intent by our own id; a payment for another order is routed to the intent that owns it, or opens `UNKNOWN_ORDER`; the claiming intent never changes. The gate's A5 order mismatch is now REJECT (T012 updated to match R1).
> - **T042**: `checkout` added to the recharge and subscription-purchase responses; the public key comes from the adapter (`checkoutKeyId`), the secret never leaves it; no prefill (C7).
> - **T043**: `GET /payments/intents/:intentId` (owner or staff, database only, `rl:payment-status` 60/min) and `POST …/verify` (owner only, idempotent; order check, then signature in the adapter, then `fetchPayment` outside any transaction, then the gate on path VERIFY). New codes `PAYMENT_ORDER_MISMATCH`, `PAYMENT_SIGNATURE_INVALID`, `PAYMENT_GATEWAY_UNAVAILABLE`.
> - **T040** written: `tests/integration/payment-checkout-flow.test.ts` (fake Razorpay credentials, in-process `fetch` stub; no network).
> - Evidence: typecheck exit 0; ESLint and Prettier clean on all changed files; payment unit tests 229, 225 pass, 0 fail, 4 todo. App-side tasks (T044–T050) are **blocked**: see the Phase 3 SDK findings in the session report.
> - **T040, two recorded runs (2026-10-22, before the fix patch)**: the 10 payment integration files on the isolated DB `zaroorat_rzp005_test`. Both runs completed: 129 tests, 124 pass, 5 fail, 0 cancelled. T040 itself: 10 tests, 9 pass, 1 fail in both runs. The failure was "answers 503 … when the provider is unavailable": `verify` answered `500 INTERNAL`, because both error handlers passed only `PaymentsUnavailableError` through as a 5xx. The other 4 failures are the known `ROUTING_PROVIDER_UNAVAILABLE` ones (authorization-bola ride identity; subscription-lifecycle activation and two expiry cases), outside payments.
> - **Fix patch (2026-10-22, uncommitted)**: `PaymentGatewayUnavailableError` → `503` with its fixed message in both the payments and subscriptions handlers; a transient provider failure in `IntentService.createIntent` → `503 PAYMENT_GATEWAY_UNAVAILABLE`, nothing written. New tests: order creation down → 503 and no intent, then a same-key retry → exactly one intent and one order (recharge; subscription also one subscription row); a handler unit case per route family. After the patch: T040 12/12 alone; the 10 files twice, 131 tests, 127 pass, 4 fail (the same 4 routing failures), 0 cancelled, both runs; payment unit tests 231, 227 pass, 0 fail, 4 todo; typecheck exit 0. The two-intent lock is unchanged (follow-up T111).

- [ ] T042 [US1] **P0** — Add the checkout payload to the recharge response (`back/src/modules/payments/controllers/commission-wallet.controller.ts`; shape in `back/src/modules/payments/schemas/payment.responses.ts`):
  - the public `key_id` from `payment-gateway-resolver.service.ts`;
  - the amount in paise;
  - **no prefill** until UD-9 is approved.

  Also tighten the 2-decimal and bounds validation in `back/src/modules/payments/schemas/payment.schemas.ts`.

- [ ] T043 [US1] **P0** — Add `GET /payments/intents/:intentId` and `POST /payments/intents/:intentId/verify` to `intent.controller.ts` and `payment.routes.ts`:
  - UUID param schema;
  - `rateLimits.paymentStatus` in `back/src/config/rate-limit/rate-limit.config.ts`;
  - signature check with `verifyRazorpayPaymentSignature` against the **stored** order id, then `fetchPayment`, then the gate;
  - new error codes in `back/src/modules/payments/errors/payment.errors.ts`.
  - `verify` shares `rl:payment` (20 per hour per user) with recharge creation and `confirm`. A test shows that a 429 on verify changes nothing and that the webhook or reconciliation still applies the payment (K-18).
  - Needs: T024, T035.
  - Done when: T040 passes.
- [ ] T042b [US1] **P1, only if T005 selects TD-1b** — Backend-hosted Standard Checkout page for the Custom Tabs fallback (MI-13):
  - a route serving Razorpay's web checkout for one intent, opened with a single-use token bound to the intent and its driver, expiring within minutes;
  - Razorpay's `callback_url` posts to the backend, which runs the same verify path (signature, provider fetch, gate), then redirects to `zarooratdriver://payments/return?intentId=…`;
  - the route moves no money itself.
  - Needs: T005 = TD-1b; **UD-12** (it is a second public payment route, against constitution §10.2 and SEC-4 as written); T043.
  - Done when: TM-16 (hosted-page variant) and TM-34 show the token is single-use, expires, and cannot open another driver's intent.

### Driver App

- [ ] T044 [US1] **P1** — Add `react-native-razorpay` to `app/package.json` (or skip it under TD-1b). Create the config plugin `app/plugins/withRazorpay.js`:
  - Android `<queries>`: VIEW `upi` scheme plus the UPI app packages listed in Razorpay's Android docs;
  - proguard keep rules from the SDK README;
  - iOS `LSApplicationQueriesSchemes` `tez`, `phonepe`, `paytmmp` (set in app config, as the README requires for Expo).

  Register the plugin in `app/app.json`. Add `app/plugins/__tests__/withRazorpay.test.ts` asserting the generated entries (TM-18).
  - Needs: T005, T006 (`package-lock.json` has uncommitted changes).
  - **2026-10-22**: T005 Stage 1 passed in an isolated worktree: debug and R8 release builds compiled, with no device test. The review package [t044-integration-review.md](./t044-integration-review.md) and the patch are prepared. **Not applied**: the four approvals in decisions.md §2d are pending.

- [ ] T045 [P] [US1] **P1** — Create `app/src/services/payments/checkout.ts`: open Standard Checkout from the backend `checkout` payload; normalise success, failure, dismiss and network error using the codes recorded in T005. Under TD-1b, open the hosted page with `expo-web-browser` and handle the `zarooratdriver://payments/return` deep link.
- [ ] T046 [P] [US1] **P1** — Create:
  - `app/src/services/payments/attemptStore.ts`: one attempt per purpose in `expo-secure-store` `{attemptId, purpose, idempotencyKey, intentId, startedAt}` (TD-8). On resume, checkout may reopen only while the backend reports the intent `PENDING` or `FAILED`, on the same order. Any other status (`SUCCEEDED`, `EXPIRED`, `IN_REVIEW`, `REFUNDED`) shows the status screen and clears the attempt once it is terminal;
  - `app/src/services/payments/usePaymentStatus.ts`: a TanStack Query polling hook.
  - Done when: T041 passes.
- [ ] T047 [US1] **P1** — Extend `app/src/services/api/money.ts`:
  - a typed `rechargeCommissionWallet` returning `checkout`;
  - `getPaymentIntent(intentId)` and `verifyPayment(intentId, body)`, each passing the attempt's `Idempotency-Key` explicitly (the interceptor otherwise generates a new one, `client.ts:209-211`).

  Add the routes, and add `verify` to `IDEMPOTENT_POST_PATHS`, in `app/src/services/api/endpoints.ts`.
  - **C8 (Owner, 2026-10-21)**: one idempotency key per logical attempt, persisted with the attempt (TD-8) and reused for every retry of it; never a fresh key per request.

- [ ] T048 [US1] **P1** — Create `app/src/features/billing/PaymentStatusScreen.tsx` and the route `app/app/account/payment-status.tsx`:
  - states: Verifying / Success (server balance) / Failed / Not completed / In review (with support reference);
  - accessibility: amounts read as words, live-region announcements;
  - resume on app launch and on network regain from the attempt store.
- [ ] T049 [US1] **P1** — Rework `app/src/features/billing/AddMoneyScreen.tsx`:
  - amount chips only from recharge options;
  - custom-amount bounds from the backend;
  - one Pay button, disabled while a request is in flight (FR-053);
  - start or resume the attempt, open checkout, call verify, navigate to the status screen.

  Remove the "Recharge initiated" alert and the `ADD_MONEY_PLANS` usage in `app/src/features/billing/constants/plans.ts`.
  - **C8 (Owner, 2026-10-21)**: no new attempt until the current intent's authoritative status (T043) is resolved, or the backend's documented policy permits one. A cancelled checkout or an unknown provider outcome shows "processing" and re-checks status; it is never shown as a failure.

- [ ] T050 [US1] **P1** — Fix `app/src/features/billing/WalletScreen.tsx` and `app/src/features/account/AccountScreen.tsx`:
  - no earnings-wallet fallback for the balance;
  - correct signs via the T041 mapping;
  - commission rate and minimum-balance copy from the backend, or omitted;
  - hide payment buttons when `featureFlags['payments.driver_checkout']` is false, read through `app/src/design-system/AppConfigProvider.tsx`.

  Update the strings in `app/src/design-system/tokens/strings/{en,hi,ur}.ts`.
  - Needs: T006 (`AppConfigProvider.tsx` has uncommitted changes).

**Checkpoint**: TM-16…TM-21 pass on a device. US1 is releasable behind the flag.

---

## Phase 4: User Story 2 — Driver buys a subscription plan (Priority: P1) — wave S, every task `[SUB]`

**Goal**: subscription purchase works against real Razorpay, with one order per pending subscription and guaranteed activation.

**Independent test**: TM-22…TM-24 (quickstart S10, drill D3). Gates G3-S, G4-S, G6-S and G8-S in plan.md. `payments.subscription_checkout` stays OFF until they are signed.

### Tests first

- [ ] T051 [P] [US2] `[SUB]` **P0** — Extend `back/tests/integration/subscription-lifecycle.test.ts` (TM-22):
  - a FAILED intent plus a retried purchase returns the same `intentId` and order;
  - a plan change while pending cancels the old intent;
  - a capture on the cancelled order → `UNMATCHED_CAPTURE` review case, no second activation, no dead letter, no revenue posting;
  - an old intent that is FAILED or EXPIRED when superseded is CANCELLED too; a later capture on it → case, not an applied payment;
  - a supersession racing a capture on the old intent (real concurrency) → either the old payment activates the subscription and no new intent is created, or the old intent is CANCELLED and the capture opens a case. Never both.

  Fix the vacuous assertion in `back/tests/integration/payment-intent-h1.test.ts`: assert the subscription linked to that intent is ACTIVE and no `outbox_events` row is FAILED.

### Backend

- [ ] T052 [US2] `[SUB]` **P0** — Implement TD-11 in `back/src/modules/subscriptions/services/subscription.service.ts`:
  - check `payments.subscription_checkout` and the pilot allowlist **before any write**: today the PENDING_PAYMENT subscription row is created before the intent (`subscription.service.ts:120-142`), so a refused intent would leave an orphan row. Staging a plan change on an ACTIVE subscription needs no payment and is not gated;
  - reuse the pending subscription's intent when it is FAILED or PENDING and not expired;
  - otherwise supersede it: lock the old intent row (`SELECT … FOR UPDATE`). If it is SUCCEEDED, do **not** create a new intent (the subscription activates through the consumer or the recovery job). Otherwise mark it `CANCELLED` (from PENDING, FAILED or EXPIRED) and create a new one;
  - return the `checkout` payload.

  In `back/src/modules/subscriptions/consumers/subscription-payment.consumer.ts`, an event whose intent matches no subscription must not throw (D-6). After the supersession rule it can only happen through a defect, because the money is already applied. It opens an `UNMATCHED_CAPTURE` case linked to the SUCCEEDED payment row via `PaymentReviewCaseRepository` and alerts. Any refund then follows the normal Finance refund path.
  - Done when: T051 passes, including the supersession race.

- [ ] T053 [US2] `[SUB]` **P0** — Recovery-scheduling tests, written before T054 (both TM-23):
  - unit test in `back/tests/unit/jobs/payment-schedules.test.ts`: `SUBSCRIPTION_RECONCILIATION` exists in `JOB_NAMES`, `JOB_SCHEDULES` and `MAINTENANCE_HANDLERS`;
  - extend `back/tests/integration/subscription-h4-recovery.test.ts`: with 150 abandoned pending subscriptions plus 1 paid one, the job activates the paid one in one run.
- [ ] T054 [US2] `[SUB]` **P0** — Schedule `SubscriptionReconciliationJob`:
  - add `SUBSCRIPTION_RECONCILIATION` to `back/src/jobs/queues/index.ts`;
  - add a 5-minute cron (`SUBSCRIPTION_RECONCILIATION_CRON`) in `back/src/jobs/scheduler/index.ts`;
  - add the handler key in `back/src/jobs/workers/index.ts`;
  - in `subscription-reconciliation.job.ts`, rewrite the query to join SUCCEEDED intents, oldest first, and write a T038 run row.
  - Done when: T053 passes; the staging log shows "Job schedule registered" for it.

### Driver App

- [ ] T055 [US2] `[SUB]` **P1** — Rework `app/src/features/billing/PlanBillingScreen.tsx`:
  - hide the Subscribe action while `featureFlags['payments.subscription_checkout']` is false;
  - plans and prices only from `GET /subscriptions/plans` (an empty state, no `BILLING_CYCLES` fallback prices);
  - a confirmation dialog before `setPaymentModel` (FR-055), and show its errors instead of swallowing them;
  - Subscribe runs the same attempt → checkout → verify → status flow as T049.

  Remove the remaining financial constants from `app/src/features/billing/constants/plans.ts`.

- [ ] T056 [US2] `[SUB]` **P2** — Show actionable messages for `INSUFFICIENT_COMMISSION_BALANCE`, `DRIVER_SUBSCRIPTION_REQUIRED` and `PAYMENT_MODEL_NOT_SELECTED`, with links to Add Money / Plan & Billing, in `app/src/features/trip/IncomingRideDialog.tsx` (FR-057). Strings in `app/src/design-system/tokens/strings/{en,hi,ur}.ts`.

**Checkpoint**: TM-22…TM-24 pass.

---

## Phase 5: User Story 3 — Payments are recovered when something goes wrong (Priority: P1)

**Goal**: missed, late, duplicate and out-of-order confirmations are applied exactly once without staff action, and every captured payment is tracked (INV-7).

**Independent test**: TM-25…TM-28; drills D1, D2, D6, D7, D8.

### Tests first

- [ ] T060 [P] [US3] **P0** — Integration test `back/tests/integration/payment-recovery.test.ts` (TM-25):
  - 150 stale intents plus 1 captured → the captured one is applied within one cycle;
  - a FAILED intent with a captured provider payment within 5 days → applied once;
  - older than 5 days with nothing at the provider → EXPIRED;
  - `authorized` → stays PENDING;
  - a second run → no extra effect;
  - provider errors increment `payment_reconciliation_error_total`, not `reconciliation_mismatch_total`;
  - with 1,000 open intents and a batch of 100, every intent is checked within 10 runs (no starvation);
  - two overlapping runs (for example after the Redis lock expires) cause no double effect.

### Backend

- [ ] T061 [US3] **P0** — In `back/src/modules/payments/jobs/payment-intent-reconciliation.job.ts`:
  - scan `PENDING`/`PROCESSING`/`FAILED` intents created within `PAYMENT_INTENT_RECHECK_DAYS`, ordered `last_reconciled_at NULLS FIRST, created_at, id`;
  - stamp `last_reconciled_at` after each check, whatever the outcome (TD-13);
  - size the batch from Q11 so that one run fits inside the Redis lock: lock TTL ≥ batch × provider timeout (15 s) + margin. Overlap safety still comes from the database (data-model §8), not from the lock;
  - write a T038 run row with scanned, applied, held, expired and error counts;
  - add the knob to `payment.config.ts` and `back/.env.example`.
  - Needs: T006, T020.
  - Done when: T060 passes, including the no-starvation and overlap cases.
- [ ] T062 [US3] **P0** — The EXPIRED rule (D-3), in the same job via `IntentService`: expire only when the provider reports nothing, or failed-only, and the age exceeds the window.
  - Needs: D-3 Finance confirmation.
- [ ] T063 [US3] **P1** — Replace the misattributed metric at `payment-intent-reconciliation.job.ts:75` with `payment_reconciliation_error_total`.
  - Done when: T060 passes.
- [ ] T064 [US3] **P1** — Dead-letter requeue (D-5):
  - `requeueDead(id)`, a conditional update, in `back/src/core/events/OutboxRepository.ts`;
  - admin routes `GET /api/v1/admin/payments/outbox/dead-letters` (`operations:read`) and `POST /api/v1/admin/payments/outbox/:eventId/requeue` (`operations:write`), limited to payments and subscriptions event types, with `recordAdminAction`, in `back/src/modules/admin/payment-management/payment-management.routes.ts` and `payment-management.controller.ts`;
  - test `back/tests/integration/outbox-requeue.test.ts` (TM-27): requeue twice → one activation, two audit rows; another module's event → 409.
- [ ] T065 [US3] **P0** — Commission-wallet reconciliation (FR-030) in `back/src/modules/payments/jobs/reconciliation.job.ts`:
  - a keyset scan over **all** customer, earnings and commission wallets;
  - balance = Σ transactions, and = the ledger position after cut-over;
  - record each mismatch and emit the existing `reconciliation_mismatch_total` with a `walletType` label; the alert (quickstart monitoring) pages Finance;
  - never auto-correct a balance;
  - write a T038 run row.

  Extend `back/tests/integration/payment-reconciliation.test.ts` (TM-28) with drift on wallet #150 and on a commission wallet.

- [ ] T066 [P] [US3] **P0** — Integration test `back/tests/integration/payment-provider-sweep.test.ts` (TM-26). With a stubbed `listPayments` over two pages:
  - an applied payment → no action;
  - a captured payment for an open intent → applied through the gate;
  - an unknown order → `UNKNOWN_ORDER` case;
  - a refunded payment without our refund → `EXTERNAL_REFUND` case;
  - an authorised-then-auto-refunded payment (`captured=false`) → ignored;
  - a second run → no new cases;
  - after the sweep has not run for 72 h, the next run starts its window at the last successful run's end (minus overlap), so a payment captured 60 h earlier is still found.
- [ ] T067 [US3] **P0** — Implement `back/src/modules/payments/jobs/provider-sweep.job.ts` (TD-16):
  - every 30 min, paging with `skip`. The window starts at the earlier of (now − 48 h) and (the last successful run's `window_end` − 30 min), so an outage never skips payments; the window ends at now;
  - register it in `jobs/queues/index.ts`, `jobs/scheduler/index.ts` (`PAYMENT_PROVIDER_SWEEP_CRON`) and `jobs/workers/index.ts`;
  - write a T038 run row with counts.
  - Needs: T015, T024.
  - Done when: T066 passes.
- [ ] T068 [US3] **P1** — Daily INV-7 report: from `payment_reconciliation_runs` and the sweep, count captured payments older than 24 h outside the four tracked states, and captured-but-unapplied payments older than 20 min (SC-006). Expose them as gauges and page when non-zero. Test in `payment-provider-sweep.test.ts`.

**Checkpoint**: TM-25…TM-28 pass; D1, D2, D6, D7, D8 pass in staging.

---

## Phase 6: User Story 4 — Mismatched payments never move money (Priority: P2 in the spec; P0 for live money)

**Goal**: Finance resolves review cases within 24 hours as CREDIT or REFUND.

**Independent test**: TM-29; drill D4, then resolve.

- [ ] T080 [P] [US4] **P0** — Integration test `back/tests/integration/admin-payment-review.test.ts` (TM-29):
  - list and detail show sanitised evidence;
  - CREDIT is allowed only under UD-1 (never for `MULTIPLE_CAPTURES`), else `422 REVIEW_CREDIT_NOT_ALLOWED`;
  - REFUND creates a refund with the ledger legs UD-2 defines, and moves the intent `MANUAL_REVIEW → CANCELLED`, so `GET /payments/intents/:id` reports `REFUNDED`;
  - an `EXTERNAL_REFUND` case cannot be resolved until UD-7 defines how; until then it stays OPEN;
  - concurrent resolves → one winner (`409 REVIEW_CASE_ALREADY_RESOLVED`);
  - an audit row with actor, reason and time;
  - a missing `finance:execute` → 403;
  - after every resolution, every ledger group in the database balances (Q8 = 0).
- [ ] T081 [US4] **P0** — Create `back/src/modules/payments/services/review/payment-review.service.ts`:
  - CREDIT moves the `CAPTURED_REVIEW` row to SUCCEEDED, posts per UD-2, and applies the wallet credit or the activation event; any excess becomes a refund (UD-1 a);
  - REFUND calls `RefundService` with the review source and the UD-2 refund legs, then moves the intent to CANCELLED (data-model §2);
  - `EXTERNAL_REFUND` resolution exactly as UD-7 decides (no path is assumed).

  Extend `back/src/modules/payments/services/refund/refund.service.ts`: `assertRefundable` accepts `CAPTURED_REVIEW` rows only when called by this service.
  - Needs: **UD-1, UD-2 (with refund legs), D-4 and D-6 Finance confirmation; UD-7 for `EXTERNAL_REFUND`**; UD-6 for a second approver (development proceeds with one approver, which is not an approval of that option).

- [ ] T082 [US4] **P0** — Admin routes `GET /finance/payment-review-cases`, `GET /finance/payment-review-cases/:id` and `POST /finance/payment-review-cases/:id/resolve` in `back/src/modules/admin/payment-management/finance.controller.ts`, `finance.schemas.ts` and `payment-management.routes.ts`. Filters run in the query, before pagination.
  - Needs: T081, T006.
  - Done when: T080 passes.
- [ ] T083 [US4] **P1** — Alert when a review case stays open for more than 24 h: a `payment_review_case_open_age_seconds` gauge in `payment.metrics.ts`, emitted by `reconciliation.job.ts`.

---

## Phase 7: User Story 5 — Refunds reverse exactly what was paid (Priority: P2 in the spec; P0 for live money)

**Goal**: refund amounts are locked after reservation; provider refunds are idempotent; recovered payments are refundable; unknown outcomes are resolved only by Razorpay.

**Independent test**: TM-30, TM-31, TM-32 (quickstart S7, plus refunding a payment applied in drill D2).

- [ ] T084 [US5] **P0** — Lock the refund amount (D-7) in `approveRefund`/`updateRefundWorkflow` in `back/src/modules/admin/payment-management/finance.service.ts`:
  - read and update inside one transaction with a row lock;
  - `409 REFUND_AMOUNT_LOCKED` when the amount changes while `status ≠ PENDING`.

  Test in `back/tests/integration/admin-finance.test.ts` (TM-30), including an approve racing a dispatch.
  - Needs: D-7 Finance confirmation.

- [ ] T085 [P] [US5] **P0** — Send `X-Refund-Idempotency: <refund.id>` in `createRefund` in `razorpay.client.ts`, with a byte-identical body on every retry; correct the stale comment. In `refund.service.ts`, `isDefinitiveRejection` (`:521-528`) must treat a 400 that Razorpay returns for an idempotency-key/payload mismatch (shape recorded at S11) as **unknown**, not a rejection, so a reservation is never restored while a refund may exist. Keep find-before-create first (E-6). Assert the header, the body equality and the classification in `gateway-adapters.test.ts` and `refund-lifecycle.test.ts` (TM-31).
  - Needs: T003 (S11).
- [ ] T086 [P] [US5] **P0** — Extend `back/tests/integration/refund-lifecycle.test.ts` (TM-31):
  - a payment confirmed through reconciliation (stored `pay_…`) refunds successfully;
  - a duplicate refund request with the same key returns one refund.
- [ ] T087 [US5] **P0** — Unknown refund outcomes (FR-042):
  - a `refund.processed`/`refund.failed` webhook triggers refund reconciliation for that refund only;
  - a timeout, 5xx or 409 leaves the refund PROCESSING and is never retried as a new refund;
  - a retry after the reconciliation horizon runs find-before-create first (U7).

  The timeout, 5xx and DB-loss behaviour already exists (E-6, `refund.service.ts:54-60,328-340`) and must not regress. New here: the `refund.*` webhook trigger and the 400 classification from T085.

  Tests in `refund-lifecycle.test.ts` (TM-31): timeout → PROCESSING; then Razorpay `processed` → SUCCEEDED; or `failed` → reservation restored exactly; a `refund.processed` webhook settles the matching refund; a 400 under the key leaves it PROCESSING.

---

## Phase 8: User Story 6 — Operators see and act on payment problems (Priority: P3 in the spec; lookup and review screens P1 for the pilot)

**Goal**: real data in admin, a review queue, a dead-letter tool and payment lookup; no fabricated values.

**Independent test**: TM-33.

- [ ] T089 [US6] **P1** — Backend read endpoint `GET /api/v1/admin/finance/drivers/:driverId/commission-wallet?cursor&limit` (`finance:read`) in `finance.service.ts` and `finance.controller.ts`, with a test in `admin-finance.test.ts`.
  - Needs: T006 (`payment-management` module has uncommitted work in `document-compliance.service.ts`).
- [ ] T090 [US6] **P1** — In `admin/src/modules/driver-management/pages/drivers/DriverDetailsPage.tsx`, remove the fake top-up modal and success toast, the `|| 1250` fallback and the client-side 7 % column (D-10). Add a regression test `admin/src/modules/driver-management/__tests__/driver-details-payment-model.test.ts` asserting none of them render (TM-33).
  - Needs: T006 (this file has −165/+17 lines of uncommitted work).
- [ ] T091 [US6] **P1** — Show the real commission-wallet balance and transactions from T089 in the Commission Wallet tab of `DriverDetailsPage.tsx`, via `admin/src/modules/driver-management/api/index.ts` and `services/index.ts`, with loading, empty and error states and no placeholders.
- [ ] T092 [US6] **P1** — Dead-letters page `admin/src/modules/financial-operations/dead-letters/` (api, pages, routes), using T064, with a confirm dialog before requeue. Register it in `admin/src/modules/financial-operations/routes/routes.tsx`; visible only with `operations:read`; requeue only with `operations:write`.
- [ ] T093 [P] [US6] **P1** — Review-queue pages `admin/src/modules/financial-operations/payment-reviews/` (list, detail, resolve CREDIT/REFUND with a required note and a confirm dialog), using T082. Register them in `routes.tsx`. Tests in `payment-reviews/__tests__/`.
- [ ] T094 [P] [US6] **P1** — In `admin/src/modules/financial-operations/refunds/components/RefundApprovalPanel.tsx`, disable editing the approved amount once a refund is reserved, and surface `REFUND_AMOUNT_LOCKED`.
- [ ] T095 [US6] **P1** — Backend `GET /api/v1/admin/finance/payments/lookup?q=` (`finance:read`) in `finance.controller.ts`/`finance.service.ts`, per `contracts/http-api.md`: exact match on intent id, `order_…`, `pay_…` or driver id; returns the intent, payment rows, event outcomes (no payloads), the review case and refunds. Test in `admin-finance.test.ts`.
- [ ] T096 [US6] **P1** — Admin payment-lookup page `admin/src/modules/financial-operations/payment-lookup/`, using T095, with a navigation entry in `admin/src/app/layouts/Sidebar.tsx` and `admin/src/app/router/index.tsx`.
  - Needs: T006 (both files have uncommitted navigation changes).
- [ ] T097 [US6] **P1** — Backend `GET /api/v1/admin/finance/payments/reconciliation-runs` (FR-064, from `payment_reconciliation_runs`) and the admin page `admin/src/modules/financial-operations/reconciliation-runs/`.
  - Needs: T038, T006.
- [ ] T098 [US6] **P1** — Permission regression (TM-33):
  - backend tests that each new admin route answers 403 without its permission (`finance:read`, `finance:execute`, `operations:read`, `operations:write`);
  - admin tests that the pages and actions are hidden without them.

---

## Phase 9: Hardening and release

- [ ] T099 [P] **P1** — DevOps: configure every alert in the quickstart "Monitoring to verify in staging" table in the team's monitoring system (U15), each with severity, a named recipient and a link to its runbook (the existing rule, `docs/14_Operations/01_incident-response.md:32`). Alert rules are not in this repository today; if the system supports rules-as-code, add them to a reviewed location and record it.
  - Needs: U15; the metrics from T034, T038, T065, T068, T083; T103 for the runbook links.
  - Done when: TM-39: an export of the configured rules matches the table, and a synthetic trigger fired each alert in staging and reached its recipient (time recorded).

- [ ] T100 **P1** — Re-run every quickstart scenario (S4–S10) and drill (D1–D10) in staging with the final release build, by the staff roles that will own them in production. Record the results in research.md (TM-32, TM-36).
  - Done when: every expected result is met and recorded with date, environment and person.
- [ ] T101 [P] **P1** — Load test against staging: a burst of 100 webhooks/s and 1,000 concurrent status polls.
  - Done when: webhook p95 < 1 s with no 5xx and no parked events; status polls show no 5xx and keep SC-004 (95 % confirmed within 10 s of capture). The measured poll p95 is recorded in research.md (TM-35); the plan sets no new latency target for it.
- [ ] T102 [P] **P0** — Security review against `back/docs/BOLA_REVIEW.md` (TM-34):
  - intent ownership on GET, verify and confirm;
  - the admin permission matrix;
  - no secret in the app bundle: inspect the built APK/AAB per quickstart;
  - the webhook route is still the only public payment route (`back/tests/integration/route-graph.test.ts`);
  - Q10 (runtime role);
  - UD-10 applied (T039);
  - record the decision on a webhook IP allowlist (Razorpay publishes the list; allowlisting is optional; K-17).
  - Done when: a signed report lists no open finding above Low.
- [ ] T103 [P] **P1** — Runbooks in `back/docs/14_Operations/02_runbooks.md`, using its existing template (Alert → Impact → Likely causes → Diagnose → Mitigate → Verify → Escalate), each with an owner role. Every page-level payment alert links to one:
  - driver "paid but not credited";
  - review-case handling;
  - dead-letter requeue;
  - webhook secret rotation;
  - **Razorpay disabled the webhook: re-enable it, then confirm reconciliation caught up**;
  - parked events;
  - kill switch;
  - Dashboard-refund policy (UD-7).
- [ ] T104 **P1** — Staging soak, 7 consecutive days, with synthetic test-mode payments, including S12 (TM-37).
  - Done when: acceptance A1–A10 in quickstart.md is evidenced; zero unexplained INV-7 items on every day; no heartbeat older than 2 × its interval; no unhandled dead letters.
- [ ] T105 **P1** — Production rollout per quickstart.md "Production rollout" (TM-38):
  - migration after the data checks;
  - flags at their seeded defaults;
  - live keys and webhook;
  - the go decision recorded;
  - a staff ₹1 live recharge through UPI intent, and its refund;
  - the UD-4 cohort, on the checkout build, added to the allowlist for the agreed period, with daily Finance review;
  - `payments.subscription_checkout` stays OFF;
  - then expand.
  - Needs: every other task in the pre-live set done; G0–G7 signed; the go decision recorded in plan.md.
- [ ] T106 [P] **P3** — Update `back/docs/DRIVER_PAYMENT_ARCHITECTURE_SPECIFICATION.md` gap statuses (G-02, G-03, G-04, G-05, G-12, G-13, G-14, G-15, G-16, G-17, G-18, G-21, G-29) and `back/src/modules/payments/README.md` to match the shipped behaviour.

---

## Stage A additions (2026-10-21): proposed tasks, not authorized

These come from [e2e-integration-plan.md](./e2e-integration-plan.md) §2 (N1–N4) and decisions.md §2c. They keep their N-labels for traceability.

Each starts only with its own Owner authorization; nothing here is approved for implementation.

- [ ] T107 [US1] **P1, proposed** — **N1: driver payment history** (C4; contract change pending Owner approval):
  - **Endpoint (proposed)**: `GET /api/v1/payments/intents`. The driver comes from the authenticated session only; there is no `driverId` parameter. It returns only the caller's own intents.
  - **Query**: `purpose` (optional: `DRIVER_COMMISSION_RECHARGE` or `DRIVER_SUBSCRIPTION_PAYMENT`), `status` (optional, mapped values), `limit` (1–50, default 20), `cursor` (opaque; keyset on `created_at DESC, id DESC`, stable while new intents arrive).
  - **Item**: `intentId`, `purpose`, `amount`, `currency`, `status`, `createdAt`, `completedAt` (null unless succeeded), `reviewOrRefund` (only what the Owner approves for disclosure; default: none).
  - **Never in an item**: Razorpay ids, secrets, payer email/contact/VPA/card data, internal review notes.
  - **Status mapping**: exactly the one of `GET /payments/intents/:intentId`, one shared mapper:
    - `PENDING`/`PROCESSING`/`CREATED` → `PENDING`;
    - `SUCCEEDED` → `SUCCEEDED`;
    - `FAILED` → `FAILED`;
    - `EXPIRED` → `EXPIRED`;
    - `MANUAL_REVIEW` → `IN_REVIEW`;
    - `CANCELLED` with a `RESOLVED_REFUND` case → `REFUNDED`;
    - other `CANCELLED` → `CANCELLED` (requires the contract's status list to include it, or the Owner chooses to hide superseded attempts);
    - the historical `REFUND_PENDING`/`REFUNDED` per the contract.

    No new status strings without a contract change.

  - **Rate limit**: `rl:payment-status`.
  - **Tests (integration)**:
    - own intents only, with a BOLA case added to `authorization-bola.test.ts`: another driver's intents never appear;
    - 401 without a token;
    - pagination stable while inserting during paging;
    - each mapping row;
    - purpose and status filters;
    - empty list.
  - **Tests (unit)**: the shared status mapper.
  - Needs: Owner approval of the contract text (C4); T043 (shared status mapper).
  - Done when: the endpoint section is added to contracts/http-api.md; tests pass twice on an isolated database; nothing beyond the item fields is disclosed. The app list screen is a separate, later approval.
- [ ] T108 **P2, proposed, blocked by UD-13** — **N2: durable payment state-transition history** (C5):
  - **Table (proposed)**: append-only `payment_intent_events`, one row per intent status change, in the same transaction as the change:
    - `id`, `intent_id`, `from_status`, `to_status`;
    - `source` (`WEBHOOK`, `VERIFY`, `RECONCILIATION`, `SWEEP`, `STAFF_CONFIRM`, `REVIEW_RESOLUTION`);
    - `actor_id` (staff only), `gate_rule`, `provider_payment_id`, `provider_order_id`, `created_at`.
  - **Exclusions**: no payload, no PII.
  - **Protection**: append-only triggers and the truncate guard, like T020; REVOKE from the runtime role.
  - **Decisions it needs**: retention period, access (Finance/Ops roles), privacy review (with UD-10), storage growth estimate (from Q11).
  - **Migration**: its own, with pre-checks; backfill: none (history starts at deploy).
  - **Tests**:
    - every transition writes exactly one row;
    - a rolled-back transaction writes none;
    - UPDATE/DELETE/TRUNCATE refused;
    - concurrent transitions on one intent are serialized.
  - Needs: UD-13 (Owner + Finance); migration approval; T020 deployed.
  - Done when: approved, migrated on the test targets, tests pass twice.
- [ ] T109 **P0 for G5, cross-workstream (Maps), proposed** — **N3: split the exposed shared Google Maps credential**:
  - **Today (read-only inventory, 2026-10-21)**: one key serves:
    - the backend server: Directions, Distance Matrix, Geocoding, Places (New);
    - the admin browser: Maps JavaScript API via `@googlemaps/js-api-loader`;
    - both mobile apps: Maps SDK for Android and iOS via `react-native-maps`.

    It is committed and pushed in the admin panel (`.env.example`, now blanked in the working tree only) and in the customer app (tracked `.env`; its removal is staged by another contributor).

  - **Target**: separate credentials, each with application **and** API restrictions:
    - browser: HTTP referrers;
    - Android: package name + signing SHA-1s;
    - iOS: bundle id;
    - server: backend egress IPs.

    Each is stored only in its surface's secret store or untracked env. The old shared key is then deleted.

  - Owned by the Maps workstream (T006 #1/#6). Feature 005 tracks it only because G5 requires it. Operator instructions: stage-a-readiness-report.md §4b.
  - Done when:
    - the old key is deleted or disabled, and a request with it is refused;
    - each new key works on its own surface and is refused off-surface;
    - a secret scan of all four repositories finds no key value in any tracked file;
    - the customer app's tracked `.env` is removed from the index by its owner and `.env` is git-ignored.
  - History rewriting is **not** part of this task (rotation makes the committed key useless).
- [ ] T110 **P0, proposed** — **N4: revoke the old Razorpay Test Mode key pair**:
  - the Owner deactivates or regenerates it in the Razorpay Dashboard **in Test Mode**;
  - the replacement pair is placed through a secure local or secret-management process (never chat, tickets or tracked files);
  - an authorized operator runs the read-only check in stage-a-readiness-report.md §4a.
  - Done when:
    - **old pair → 401** and **new test pair → 200** on the same read-only call, recorded in the research.md log (date, operator, HTTP statuses; key id at most as its last 4 characters);
    - `.env.development` (and any staging or admin setting that held it) contains only the new pair;
    - the residual local copies are handled only under a separately approved cleanup plan.
  - Needs: nothing. **It blocks** any further backend sandbox call, T002 and Stage B.
- [ ] T111 **P2, proposed follow-up (not in the 2026-10-22 fix patch)** — **single-owner lock for R1 routing** in `IntentService.applyConfirmation`:
  - **Today**: a payment for another order is routed while the claiming intent's row lock is held, and the owner's lock is then taken. That is the only place two intent locks are held in one transaction, so two crossed presentations could deadlock.
  - **Reach**: no current caller can present a mismatched payment. The webhook resolves the intent by the payment's own order; reconciliation filters by order; `verify` rejects before any transaction. A PostgreSQL deadlock would abort one transaction with no financial effect, and the retry would succeed.
  - **Proposed change**: `gateway_intent_id` is written once at creation (the only update path rewrites the same value). So compare the payment's order to the intent's order **before** locking. A mismatch is routed without ever locking the claiming intent, leaving one intent lock per transaction. This is preferred over ordering two locks by id, which needs the same early read plus a second lock. A defensive re-check after the lock remains.
  - **Tests (write first)**:
    1. Unit: on a mismatch, only the owner's row is locked, and the claiming intent is never locked or updated.
    2. Integration concurrency (constitution §14.1): repeated `Promise.all` runs presenting A's payment to B and B's payment to A in parallel transactions. No deadlock error (SQLSTATE `40P01`); each payment is credited exactly once, to its actual owner; every ledger group balances.
  - Needs: T022, T040 green (done); its own authorization.

## Dependencies & execution order

### Phase dependencies

| Phase          | Depends on                                                                             | Notes                                             |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 Setup/gates  | —                                                                                      | T001–T008                                         |
| 2 Foundational | Phase 1 (T003 before T016; T004 before T020; T001 before T030/T031; UD-10 before T039) | **Blocks all stories**. T035 may ship alone first |
| 3 US1          | Phase 2, T005                                                                          | —                                                 |
| 4 US2 `[SUB]`  | Phase 2; Phase 5; reuses T045–T048                                                     | Wave S only; not in the pre-live set              |
| 5 US3          | Phase 2                                                                                | No app dependency                                 |
| 6 US4          | Phase 2 (T022–T024); T081 needs UD-1, UD-2 and Finance confirmations                   | —                                                 |
| 7 US5          | Phase 2; T084 needs D-7 confirmation                                                   | T086 uses US3's reconciliation                    |
| 8 US6          | T064, T082, T089, T095, T097 backend endpoints                                         | T090 can ship any time after T006                 |
| 9 Release      | The pre-live set (every P0/P1 task not tagged `[SUB]`)                                 | T105 also needs G0–G7 and the go decision         |

### Within each phase

- Tests come first and must fail before their implementation.
- Schema (T019–T021) comes before code that writes new columns.
- Backend contracts come before the app or admin screens that call them.

### Story independence

- US1 and US2 share the app payment plumbing (T045–T048) but are tested separately.
- US3 has no app dependency.
- US4 and US5 can proceed in parallel with US1 and US2 once Phase 2 is done.

## Parallel examples

```text
# Foundational unit tests (separate files):
T010 T011 T012 T013 T014
# Foundational integration tests (separate files):
T018 T022 T025 T028
# US1 tests:
T040  back/tests/integration/payment-checkout-flow.test.ts
T041  app/src/services/payments/__tests__/*.test.ts
# US1 app plumbing (after T044):
T045 T046
```

## Implementation strategy

### First live money (recharge pilot, wave R)

The first live payment needs the whole **pre-live set**: every P0 and P1 task not tagged `[SUB]`, except T105 itself and T106. It also needs G0–G7 signed and the go decision recorded (plan.md → Go/no-go). This is the same rule as plan.md's steps 1–9; step 10 is T105.

"US1 + US3 alone" (the original MVP) is **not** enough. Without T080–T087, a mismatched or duplicate capture during the pilot could not be resolved or refunded safely, and the 24-hour review target could not be met.

### Then

1. Wave S (subscriptions): T051–T056, then G3-S, G4-S, G6-S, G8-S, then `payments.subscription_checkout` on for the cohort.
2. P2 items before expanding beyond the pilot cohort.

### Team split

- Backend A: Phase 2 → US3 → US4/US5.
- Backend B: T035–T038, T042–T043, T052–T054, then admin endpoints T064, T089, T095, T097.
- Mobile: T005 spike → US1/US2 app tasks.
- Admin: T090 as soon as T006 clears it, then US6.

## Notes

- Every task that encodes a business rule cites its decision ID. No task may change a financial policy.
- A test is never weakened to pass (constitution §15.3). The webhook replay test changes only because of AM-1.
- Commit per task with conventional commits (`payment`, `db`, `admin`, `docs` scopes; constitution §18.6). Never use `--no-verify`.
