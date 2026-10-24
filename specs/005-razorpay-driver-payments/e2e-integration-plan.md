# Driver App ↔ Razorpay End-to-End Integration — Plan and Release-Gate Checklist

**Input**: "Driver App — Razorpay End-to-End Payment Integration Specification" (draft for engineering approval, received 2026-10-21; called **the draft** below).

**Date**: 2026-10-21 · **Status**: plan only; no code changed · **Production**: **NO-GO**

**What this document is.** The draft's §16 lists ten deliverables. This document gives:

- deliverable **1**, the dependency-aware task plan (§4);
- deliverable **10**, the release-gate checklist with PASS / FAIL / BLOCKED (§5).

Deliverables 2–9 need implementation and test or operational evidence that does not exist yet (§6).

**How the draft relates to the existing feature.** It re-states the existing feature `005-razorpay-driver-payments` almost point for point:

- the HTTP contract `contracts/http-api.md` already defines the recharge `checkout` payload, `GET /payments/intents/:id` and `POST …/verify`;
- `plan.md` already defines gates G0–G8 under the same names.

So the plan below **maps the draft onto the existing task IDs** instead of creating parallel work. It adds new tasks only where the draft asks for something no task covers. Where the draft conflicts with an approved decision, the decision stands until the Owner says otherwise (§2).

---

## 1. Re-verified baseline (2026-10-21, read-only)

| Draft baseline item                            | Re-verified   | Evidence                                                                                                                                     |
| ---------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver App Razorpay SDK absent                 | **Confirmed** | Not in app `package.json`; no native config; no `src/services/payments/`                                                                     |
| Recharge screen calls the API without checkout | **Confirmed** | `AddMoneyScreen.tsx:105–112`: alert "Recharge initiated… Complete checkout", then `router.back()`                                            |
| Subscription checkout is a placeholder         | **Confirmed** | `PlanBillingScreen.tsx:144`: `// Payment gateway checkout would open here with intentId`                                                     |
| No public checkout payload                     | **Confirmed** | `commission-wallet.controller.ts` returns `intentId`, `intentStatus`, `gatewayIntentId`, `amount`; no `checkout` (T042)                      |
| Verify/status APIs missing                     | **Confirmed** | `payment.routes.ts`: only `/intents/:intentId/confirm` (staff), recharge, recharge-options, webhooks (T043)                                  |
| Development gateway is `mock`                  | **Confirmed** | No `payment.active_provider` setting; `PAYMENT_DEFAULT_GATEWAY` unset ⇒ `mock` in development                                                |
| Checkout switches OFF                          | **Confirmed** | Dev DB: `payments.driver_checkout` OFF, `payments.subscription_checkout` OFF, `payments.pilot_mode` ON (allowlist not enforced)              |
| Five-minute webhook rejection                  | **Confirmed** | `PAYMENT_WEBHOOK_TOLERANCE_SEC` default 300 (max 3600); checked before deduplication; a stale event gets 400                                 |
| Database safeguards only on a disposable clone | **Confirmed** | Migration `20261021120000` applied only to `zaroorat_rzp005_test`; dev 72, `zaroorat_test` 74 migrations                                     |
| Physical-device verification not done          | **Confirmed** | No physical Android device available; no payment evidence on the emulator either (dev DB: 0 non-fixture intents, 0 webhook events ever)      |
| Production NO-GO                               | **Confirmed** | G0–G8 unsigned                                                                                                                               |
| _(not in the draft)_ Old Razorpay test key     | **FAIL**      | After the reported rotation, the old test pair still authenticated (HTTP 200, read-only call, 2026-10-21); `.env.development` still holds it |

---

## 2. Review of the draft: points for Owner decision

> **Stage A (2026-10-21):**
>
> - C1, C2, C3, C6, C7 and C8 are recorded as Owner-approved in decisions.md §2c.
> - C4 is a requested proposal (T107).
> - C5 is open as UD-13 (Owner + Finance).
> - N1–N4 are tasks T107–T110 in tasks.md.
>
> The table below is the original review, kept for traceability.

| #   | Draft says                                                                                                                                          | Conflict or gap                                                                                                                                                                                                                                                     | Options                                                                                                                                                                                                                                                           | Recommendation                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C1  | §5.1 lists "persist intent" (step 3) before "create Razorpay order" (step 4); §6.1 "persist the intent before returning a usable checkout response" | **Owner decision TD-3 (2026-10-21)**: the order is created first, then the intent is written; an orphan unpaid order is accepted. The current design already satisfies "persist before returning". Persisting **before** the provider call would be TD-3 option (b) | (a) Keep TD-3: order first, orphan accepted. (b) Persist first (status CREATED), then create the order; reopens data-model §2 ("CREATED never written")                                                                                                           | (a), unless the Owner wants (b). Either way §6.1's wording is met           |
| C2  | §2.1/§5.3 "Native Razorpay Checkout"                                                                                                                | T005 may find the native SDK incompatible with the app's React Native/New Architecture setup. The fallback **TD-1b** (hosted checkout in Custom Tabs, needs UD-12) is not native                                                                                    | (a) Native only; if the SDK fails T005, the feature waits. (b) Allow TD-1b as a documented fallback                                                                                                                                                               | Decide **before** T005 reports, so the spike knows its pass criterion       |
| C3  | §8 "Reconcile provider payment and refund records before applying financial effects whenever the risk conditions require it"                        | The contract requires the webhook handler to answer within 5 s with **database work only** (no provider call). A synchronous provider lookup in the webhook breaks that                                                                                             | (a) Refund-aware check from **stored** refund events (database only) in the webhook; provider checks in reconciliation and sweep. (b) The webhook holds risky captures as "pending verification" and an async job verifies them with the provider before applying | (a), plus (b) for any capture whose payment has refund history              |
| C4  | §6.4 driver payment history (intent reference, purpose, status, timestamps, review/refund status)                                                   | The contract has only commission-wallet **transactions** (credits), so failed, pending, review and refunded attempts are invisible to the driver                                                                                                                    | (a) New `GET /api/v1/payments/intents?purpose=&limit=` for the driver's own intents. (b) Status per intent only (T043), no list                                                                                                                                   | (a): new task N1, contract addition                                         |
| C5  | §12 "every financial state transition must record … actor/source, prior state, resulting state"                                                     | Today: the FR-035 gate audit is a **log line**; ledger and outbox are durable, but intent status history is not stored                                                                                                                                              | (a) Durable `payment_intent_events` (prior → next, source, actor, provider ids). (b) Accept logs + ledger + outbox as the audit trail                                                                                                                             | Owner + Finance; if (a), new task N2 plus a migration                       |
| C6  | §11 "Test environment: … configure a test webhook endpoint"                                                                                         | Razorpay must reach the backend over public HTTPS. A local backend (emulator/device runs) is not reachable without a tunnel                                                                                                                                         | (a) Staging only (T002) for webhook-dependent end-to-end runs. (b) An authenticated tunnel to a local test backend for development runs                                                                                                                           | (a) for gate evidence; (b) only with an Owner-approved tunnel and test keys |
| C7  | §5.2 "validated prefill details where appropriate"                                                                                                  | **UD-9 open**: the phone-number prefill is omitted until decided                                                                                                                                                                                                    | Decide UD-9, or keep it omitted                                                                                                                                                                                                                                   | Keep omitted until UD-9                                                     |
| C8  | §10 "Payment fails: allow a new attempt only under the approved retry rules"                                                                        | No written retry rule. Razorpay lets the driver retry inside the same checkout and order; a new **intent** is a new attempt key (TD-8)                                                                                                                              | (a) Retries within the same order are allowed; a new intent only after the previous one is FAILED, EXPIRED or resolved. (b) Always a new intent                                                                                                                   | (a); written into T043/T049 acceptance                                      |

The draft adds three needs that no existing task covers:

| ID     | New task                                                                                                               | Source              | Needs                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| **N1** | Driver payment-history endpoint + app list                                                                             | Draft §6.4, C4      | C4 decision; T043                                                                |
| **N2** | Durable payment state-transition audit                                                                                 | Draft §12, C5       | C5 decision; migration approval                                                  |
| **N3** | Split Google Maps credentials into browser, mobile and server keys, each restricted, and rotate the exposed shared key | Draft §12 "Secrets" | Maps workstream owner (T006 #1/#6); Google Cloud access; **outside feature 005** |

There is also one operational task:

- **N4**: revoke the old Razorpay test key and record that it gets **401**, configure the new pair, and clean up residual local copies (approval pending).

---

## 3. Traceability: draft requirement → existing work → status

Status words:

- **Code (uncommitted)**: implemented in the working tree, tested locally, not reviewed or merged.
- **Not started**.
- **Blocked**: a named dependency is missing.

| Draft §  | Requirement                                                                            | Existing task / decision                                                                | Status                                                                                                                | Evidence / gap                                                                                  |
| -------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 5.1, 6.1 | Recharge intent: auth, switch, amount, scoped idempotency, real order                  | T017 ✓, T035 ✓, T016 ✓; pilot allowlist T037                                            | Code (uncommitted) except T037 (Not started)                                                                          | Unit + integration tests with the **mock** gateway; no real Razorpay order from the backend yet |
| 5.2      | Checkout payload                                                                       | T042                                                                                    | Not started                                                                                                           | —                                                                                               |
| 5.3      | SDK compatibility evidence                                                             | T005 (TD-1/TD-1b), C2                                                                   | Not started                                                                                                           | U1/U2 open                                                                                      |
| 5.4      | Outcome handling (success, failure, cancel, background, reopen, network, backend down) | T045–T050, T041                                                                         | Not started                                                                                                           | —                                                                                               |
| 5.5      | One key per attempt, reused on retry                                                   | T047 (app), TD-8                                                                        | Not started (app sends a new UUID per request)                                                                        | `client.ts:211`                                                                                 |
| 6.2      | Verify                                                                                 | T043 (+ R1 decided)                                                                     | Not started                                                                                                           | Gate rule A1 exists (`payment-application-rules.ts`)                                            |
| 6.3      | Status                                                                                 | T043                                                                                    | Not started                                                                                                           | —                                                                                               |
| 6.4      | History                                                                                | **N1**                                                                                  | Not started                                                                                                           | C4                                                                                              |
| 7        | Provider adapter (order vs payment ids, documented lookup, receipt, units, timeouts)   | T015 ✓, T016 ✓; T008                                                                    | Code (uncommitted)                                                                                                    | Sandbox S1–S11 (direct API calls) recorded 2026-10-20                                           |
| 8        | Signature, dedupe, freshness, outcomes, unusable payload, delayed, refund-aware        | T001 → T030 → T026 → T031, T033; R4 decided; R2-T (refund-aware); C3                    | Partial: signature + gate in code; freshness, durable outcomes, failure persistence, refund awareness **not started** | 300 s window rejects Razorpay retries                                                           |
| 9        | Atomic, exactly-once credit; database backstop                                         | T024 ✓ (gate), T020 (migration), T018, T028                                             | Gate in code; **migration on no shared DB**; T018/T028 Not started                                                    | Integration 111/111 ×2 (mock); no concurrency test                                              |
| 10       | Failure/refund/recovery matrix                                                         | T032, T061, T062, T066/T067, T084–T087, T080–T083, R2-T                                 | Not started (except the gate's review path)                                                                           | —                                                                                               |
| 11       | Data checks, migration safety, environment separation                                  | T004 (dev run; staging/prod BLOCKED), T020, T019c, migration-readiness-checklist.md; C6 | Blocked                                                                                                               | Runbook ready                                                                                   |
| 12       | Secrets, monitoring, audit                                                             | N4, N3, T034, T038, T099, T083, T068; C5/N2                                             | FAIL (old key active) / Not started                                                                                   | —                                                                                               |
| 13       | Backend + app tests; end-to-end on emulator **and** physical device                    | T018, T025, T028, T030, T040, T041, T060, T066, T080, T086; T100, T104                  | Not started; **no physical device available**                                                                         | —                                                                                               |
| 14       | Gates G0–G8                                                                            | plan.md gates; T105                                                                     | All unsigned (§5)                                                                                                     | —                                                                                               |
| 2.2      | Subscription wave separate                                                             | T051–T056, R6a–c decided, G3-S/G4-S/G6-S/G8-S                                           | Not started; switch OFF                                                                                               | —                                                                                               |

---

## 4. Dependency-aware task plan

The order follows each task's `Needs:` in tasks.md, the 2026-10-21 corrections in phase3-preparation.md §4 (migration readiness first; **T026 before T031**; T006 open), and the decisions above. Nothing here is authorized: every stage starts only with its own Owner authorization.

### Stage A — Decisions, ownership, credentials (no code)

- **A1.** Owner: C1–C8; UD-4 (pilot cohort), UD-6, UD-9, UD-10, UD-12 (if C2 allows TD-1b).
- **A2.** Finance (G0 list): UD-1, UD-2, UD-7, D-2, D-3, D-4, D-6, D-7, D-11. Packet: finance-decision-packet.md.
- **A3.** T006: name the nine workstream owners and the independent payments reviewer; confirm the review rule.
- **A4.** **N4**: revoke the old test key and record evidence that it gets 401; configure the new pair; approve the residual-copy cleanup.
- **A5.** D-3 Dashboard evidence: automatic capture and its timeout, in test and live mode.
- **A6.** T008: written questions to Razorpay, including order idempotency (TD-3).

### Stage B — Environments and data safety

- **B1.** T002: staging Razorpay **test** keys plus the staging webhook (the six events, alert email). This is the prerequisite for any real webhook evidence (C6).
- **B2.** T004: staging and production read-only checks through the operator runbook; Q4 decides UD-8 / R5-T.
- **B3.** Migration readiness (migration-readiness-checklist.md):
  - representative non-empty verification on a new disposable clone;
  - the `lock_timeout` edit;
  - other teams' pending migrations coordinated;
  - an approval naming each target and migration list;
  - then T020 to dev and `zaroorat_test`;
  - later staging, after its rehearsal.
- **B4.** T019c (the five deferred columns) as its own approved migration. It is needed before T026, T031 and T061.
- **B5.** T018 + T021's done-when on a migrated test database.

### Stage C — Backend correctness (wave R, no new money paths opened)

- **C1.** T001 (AM-1 into the constitution) → **T030** (tests first) → **T026** → **T031** (incl. R4 `UNUSABLE_PAYLOAD`) → T033.
- **C2.** T028 (concurrent exactly-once), T025 (provider truth end to end), T032 (out-of-order events).
- **C3.** R1-T (route a mismatch to its owning intent; remove the Razorpay intent-UUID fallback). **Must precede T043.**
- **C4.** R2-T (refund-aware capture per C3; external-refund detection). Detection is independent of UD-7; resolution waits for UD-7.
- **C5.** R5-T only if Q4 > 0 (UD-8).

### Stage D — Backend APIs for the app

- **D1.** T042: checkout payload (key id, order id, amount in paise, currency, name, description; no prefill per C7).
- **D2.** T043: `GET /payments/intents/:id` and `POST …/verify` (ownership 404, R1 rejection before the gate, provider `fetchPayment`, idempotent); the T040 test.
- **D3.** **N1**: payment-history endpoint (if C4 = a).
- **D4.** T037: pilot allowlist enforced (UD-4).

### Stage E — Recovery and operations

- **E1.** T038 job heartbeats → T060/T061 (FAILED scan, rotation) → T062 (EXPIRED; D-3) → T066/T067 (provider sweep) → T068 (daily INV-7 report); T065 (commission-wallet reconciliation).
- **E2.** T080 → T081 → T082 → T083 (review resolution; needs A2); T084 → T085 → T086 → T087 (refunds; D-7, sandbox S11 facts); admin pages T089–T098.
- **E3.** T034 metrics, T099 alert rules (owner, severity, runbook link for each), T103 runbooks, **N2** if C5 = a.

### Stage F — Driver App

- **F1.** T005 spike (SDK package/version, Expo/React Native/New Architecture compatibility, development build, Android release build). Decides TD-1 or TD-1b under C2.
- **F2.** T044 (dependency; lockfile coordinated with its owner per T006) → T045/T046 (checkout service) → T047 (API: one key per attempt, verify, status, history) → T048 (payment-status screen) → T049 (AddMoney: processing state, cancel → status check, retry rule C8) → T050 (Wallet: authoritative balance; flags through AppConfigProvider, coordinated).
- **F3.** T041 app tests covering every outcome in draft §5.4 and §13 "Driver App tests".

### Stage G — End-to-end evidence (Test Mode only)

- **G1.** On staging (B1), with the release candidate:
  1. driver logs in;
  2. recharge;
  3. **native** checkout;
  4. Razorpay test payment;
  5. **real sandbox webhook**;
  6. verify;
  7. one credit;
  8. balanced ledger;
  9. app shows the authoritative status and balance;
  10. repeated callback/webhook → no second credit.

  Recorded on an **Android emulator** and a **physical Android device** (none is available today).

- **G2.** Negative journeys: cancel, fail-then-retry, kill-and-reopen, network loss, delayed webhook (the sweep recovers it), duplicate webhook, under-review response, disabled-switch response; refund (S11 path) and an external-refund detection drill.
- **G3.** T100 quickstart re-run, T101 load test, T102 security review (including a bundle secret scan), T104 seven-day staging soak.

### Stage H — Release

- **H1.** Gates G0–G7 signed with evidence, reviewer and approval → go decision recorded → **T105** controlled live pilot (G8) under the enforced allowlist.

### Subscription wave (after wave R, own gates)

T051 → T052 (R6a/R6b/R6c) → T053 → T054 → T055/T056 → G3-S, G4-S (physical device, release build), G6-S, G8-S. `payments.subscription_checkout` stays OFF until then.

### Critical path

A1/A2/A3/A4 → B1 + B3/B4 → C1 (T001→T030→T026→T031) → D2 (needs C3) → F1 → F2 → G1 (staging + physical device) → G3 (T104 soak) → H1.

The longest external dependencies:

- Finance decisions;
- staging access (T002/T004);
- a physical Android device;
- the T005 SDK outcome.

---

## 5. Release-gate checklist (status 2026-10-21)

> **The current gate status is kept in [stage-a-readiness-report.md](./stage-a-readiness-report.md) §6.** The table below is the snapshot taken when this plan was written.

PASS = evidence recorded, reviewed and approved. FAIL = can be worked on now but not met. BLOCKED = waiting on access, a device or a decision outside engineering.

| Gate                            | Required evidence (draft §14 / plan.md)                                                  | Status             | What exists                                                                                                        | Missing                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0** Decisions and ownership  | Owner + Finance decisions recorded; engineering owners and independent reviewer assigned | **BLOCKED**        | Owner decisions D-1, D-5, D-10, UD-3, R1, R4, R6a–c, TD-3 recorded                                                 | Finance confirmations (D-2/3/4/6/7/11, UD-1, UD-2, UD-7); UD-4, UD-6, UD-10; T006 owners; independent reviewer; C1–C8                                                              |
| **G1** Provider and device      | SDK verified; sandbox payment completed; physical-device evidence                        | **FAIL / BLOCKED** | Sandbox S1, S2, S3, S3b, S9, S11 via direct API calls + web checkout (2026-10-20)                                  | T005 (U1/U2); S13; U4/U5/U8 closure (D-3 Dashboard evidence); **no physical device**; old test key still active (N4)                                                               |
| **G2** Data safety              | Read-only checks pass on each target; migration approved and verified                    | **BLOCKED**        | Dev T004 run (only seed anomalies); runbook; readiness checklist                                                   | Staging/production T004; representative-data verification; staging rehearsal; approvals per target                                                                                 |
| **G3** Backend correctness      | CI passes twice; concurrency and idempotency verified; no open critical/high findings    | **FAIL**           | Local runs: unit 2,077/2,086 (5 pre-existing unrelated failures); payment integration 111/111 ×2 on an isolated DB | No CI run; code uncommitted; T018, T025, T028, T030/T031, T026, T032 not done; repository lint has 7 errors (others' files); no independent review                                 |
| **G4** End-to-end               | Driver App → Razorpay → webhook/backend → wallet passes                                  | **FAIL**           | —                                                                                                                  | App checkout (T042–T050), verify/status (T043), staging webhook (T002); journeys G1/G2 on emulator **and** physical device                                                         |
| **G5** Security and performance | Secrets protected; authorization checked; performance and alerts verified                | **FAIL**           | BOLA confirm test (404, non-inference) passes; tracked `.env.example` templates cleaned                            | Old Razorpay test key still valid; residual local copies; shared Google Maps key committed and pushed (N3); TM-34 security review; bundle secret scan; T101 load test; alerts T099 |
| **G6** Operations               | Refund, review, reconciliation, incident and rollback drills                             | **FAIL / BLOCKED** | Review cases open safely (T022)                                                                                    | T080–T087 (needs Finance), T038/T061/T067, runbooks T103, drills D1–D10, the R-B rollback relief migration, PITR confirmation                                                      |
| **G7** Staging soak             | 7 days, zero unexplained captures, anomalies resolved                                    | **BLOCKED**        | —                                                                                                                  | Staging environment + everything above                                                                                                                                             |
| **G8** Controlled live pilot    | Authorization, enforced allowlist, monitored cohort                                      | **BLOCKED**        | Switches OFF everywhere (correct)                                                                                  | T037 + UD-4; G0–G7 signed; go decision                                                                                                                                             |
| G3-S / G4-S / G6-S / G8-S       | Subscription wave                                                                        | **BLOCKED**        | R6a–c decided                                                                                                      | T051–T056; physical device                                                                                                                                                         |

**Overall: NO-GO.**

The draft's stop-the-rollout conditions are already the pilot abort criteria in plan.md (G8): an unexplained capture, a duplicate credit, a ledger imbalance, wrong refund handling, or a security breach.

---

## 6. Deliverables 2–9: what each needs

| #   | Deliverable                                      | Can it be produced now?                                                            | Needs                                                   |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 2   | Implementation report with changed files         | Partly: Phase 1/2 backend changes are listed in tasks.md (Phase 1/2 status blocks) | Each new stage's authorization and implementation       |
| 3   | Provider + SDK compatibility evidence            | Provider: yes (research.md log). SDK: **no**                                       | T005                                                    |
| 4   | Automated test + CI results                      | Local results only                                                                 | A CI pipeline run on a committed branch (G3)            |
| 5   | Emulator + physical-device evidence              | **No**                                                                             | Stages D–F, a staging webhook, a physical device        |
| 6   | Sandbox webhook delivery + verification evidence | **No**                                                                             | T002 (staging webhook), D2                              |
| 7   | Ledger + wallet reconciliation evidence          | Isolated test DB only                                                              | Staging runs, T065/T068                                 |
| 8   | Migration + database verification reports        | Dev T004 + readiness checklist                                                     | Staging/production T004, representative data, rehearsal |
| 9   | Security, monitoring, runbook, rollback docs     | Partly: readiness checklist (rollback), operator runbook                           | T099, T103, T102, drills                                |
