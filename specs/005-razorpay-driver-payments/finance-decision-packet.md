# Finance Decision Packet — Razorpay Driver Payments

**Prepared**: 2026-10-21 · **For**: Finance (and the Owner where shown) · **Status**: nothing in this packet is decided.

## Background

Drivers will pay Zaroorat through Razorpay for two things only:

- commission-wallet recharges;
- subscription plans.

Before the first live payment, ten financial decisions need written confirmation. This packet explains each one in money terms, shows the evidence available today, and lists what is still needed.

**Who decides.** The "proposed decision-maker" for each item is the one named in the feature's decision log (decisions.md). **It has not been confirmed that Finance accepts each item.** Confirming the decision-maker is the first step. Nothing is recorded as decided until the named person confirms in writing.

**How to confirm an item.** Reply with:

- your name, role and date;
- the option chosen (or "approved as written");
- any amendment.

Engineering records it in decisions.md word for word.

**Where things stand.** No live money has moved. Both checkout switches are OFF in every real environment. Production is NO-GO until every item marked "needed before the first live payment" is confirmed.

| Item | Short question                                                       | Proposed decision-maker                 | Needed before first live payment?                   |
| ---- | -------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| UD-2 | Where held money sits in the books                                   | Finance / auditor                       | Yes                                                 |
| UD-1 | How a held payment is resolved                                       | Finance with the Owner                  | Yes                                                 |
| UD-7 | Refunds made outside Zaroorat (Razorpay Dashboard)                   | Owner + Finance                         | Yes                                                 |
| D-4  | Held payments resolved within 24 h, by credit or refund only         | Finance                                 | Yes                                                 |
| D-6  | A subscription payment that matches no open subscription             | Finance (refund part)                   | Yes                                                 |
| D-2  | Commission wallet never below ₹0                                     | Finance                                 | Yes                                                 |
| D-3  | Keep checking unpaid payments for 5 days, then expire                | Finance (plus Owner Dashboard evidence) | Yes                                                 |
| D-7  | A refund amount cannot change once reserved                          | Finance                                 | Yes                                                 |
| D-11 | No separate ledger posting key; duplicates blocked by database rules | Finance                                 | Confirmation only                                   |
| UD-8 | Repairing old payment records that stored the wrong reference        | Finance + Engineering                   | Only if staging/production checks find such records |

---

## What "held for review" means

The system now refuses to move money for a payment it cannot match exactly. A payment is **held** when, for example:

- Razorpay captured an amount or currency different from what the driver was asked to pay;
- a second payment arrived for something already paid;
- a payment matches no open order.

For a held payment:

- **the money is at Razorpay** (captured);
- **no wallet is credited and no subscription is activated**;
- a review case is opened for Finance;
- **nothing is posted to the ledger yet** (see UD-2).

This was tested on 2026-10-21 on test data: a payment one paisa short was held, with no credit, no activation and no ledger entry. Every distinct payment gets its own case, and a repeated notification never creates a second case.

---

## UD-2 — Where does held money sit in the books?

- **Question.** Razorpay has captured money that we have not applied. How is it recorded, and which accounts does a refund of that money post to?
- **Options.**
  - **(a) Suspense liability.** On hold: DR Gateway Clearing / CR Payment Suspense. Resolution by credit: DR Payment Suspense / CR the purpose account (driver wallet or subscription revenue). Resolution by refund: the refund draws from Payment Suspense.
  - **(b) Off the books until resolved.** No entry while held.
  - **(c) Post to the purpose account immediately.**
- **Financial consequences.**
  - (a) The ledger always agrees with what Razorpay holds. Settlement reconciliation balances. Refunds use the existing refund lifecycle, sourced from suspense.
  - (b) **Today's behavior by default.** The ledger understates gateway funds by the total held. Razorpay settlement reports will show unexplained differences equal to held amounts. Finance must also name which accounts a refund of held money posts to, because the existing refund process assumes the payment was applied.
  - (c) Recognizes wallet credit or revenue that was not earned and may have to be reversed.
- **Recommendation (Engineering, not an approval).** (a).
- **Evidence available.**
  - Each held case records "ledger not posted (UD-2 open)", so the gap is visible case by case.
  - No suspense account exists in the code; none was invented.
- **Evidence still needed.** The auditor's view of a suspense account; the account name (the architecture spec proposed "SUSPENSE: unmatched PSP").
- **Blocks.** Posting held money; resolving **any** held case, by credit or by refund.
- **If left open.** Held money stays off the books. No held case can be closed. The first live payment is blocked.

## UD-1 — How may Finance resolve a held payment?

- **Question.** When Razorpay captured something other than what was due, may Finance credit it, and for how much?
- **Options.**
  - **(a)** Credit only when the captured amount is at least the amount due and the currency is INR. Credit exactly the amount due and refund the excess. Otherwise refund the full captured amount.
  - **(b)** Always refund; never credit. The driver pays again.
  - **(c)** Credit whatever was captured.
- **Financial consequences.**
  - (a) A driver who overpaid still gets their purchase; an underpayment is returned. Needs excess-refund handling.
  - (b) Simplest; more support work and repeat payments.
  - (c) Effectively changes the price of a recharge or plan.
- **Facts Finance should know.**
  - **A second payment for something already paid can only be refunded.** The database allows one successful payment per purchase, so it cannot be credited to the same purchase. Crediting it as a new recharge would be a new policy and is not assumed.
  - **Some cases hold no extra money**, for example the same Razorpay payment claimed twice, or a payment traced back to the purchase it belongs to. They need a "close, no money moved" outcome. The current rules allow that outcome only for external refunds. Finance should say whether it applies to these too.
- **Proposed resolution table.** For confirmation or amendment:

| Case                                                   | Proposed allowed outcomes                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Overpaid                                               | Credit amount due + refund excess (option a), or refund          |
| Underpaid; wrong currency                              | Refund                                                           |
| Second payment for something already paid              | Refund                                                           |
| Subscription payment that matches no open subscription | Refund (D-6); credit only if that subscription is still payable  |
| Same payment claimed twice                             | Close, no money moved, after confirming the original was applied |
| Payment for an order we did not create                 | Trace it, then refund or close                                   |
| Refund made outside Zaroorat                           | Per UD-7                                                         |

- **Recommendation (Engineering).** (a), with the table above.
- **Blocks.** The resolution screen and process.
- **If left open.** Cases open safely (no money moves) but cannot be resolved. Drivers wait.

## UD-7 — Refunds made outside Zaroorat (Razorpay Dashboard)

- **Question.** May staff refund directly from the Razorpay Dashboard? When such a refund is detected, how is it settled?
- **Options.**
  - **(a)** Prohibit by policy, detect anything that happens anyway, and settle it under a Finance correction rule.
  - **(b)** Allow, and import such refunds automatically. That means debiting wallets or ending subscriptions without a Zaroorat decision.
- **Financial risk found in review.**
  - If a payment is refunded in the Dashboard **before** our system processes Razorpay's "payment captured" notice (Razorpay retries those notices for up to 24 h), the late notice still says "captured".
  - The driver's wallet would be credited, or the plan activated, for money already returned.
  - **Nothing detects this today.** Detection is planned work and needs no Finance decision. The _correction_ needs one.
- **Proposed settlement workflow.** For confirmation or amendment:
  1. **Prevent.** The runbook forbids Dashboard refunds; Dashboard refund rights are limited to named Finance staff.
  2. **Detect.**
     - A refund notice with no matching Zaroorat refund opens a case.
     - The daily provider check flags refunded amounts we cannot explain.
     - A capture whose payment is already known to be refunded is held, not applied.
  3. **Triage.** Finance checks what the payment paid for: nothing, a wallet credit, or a subscription.
  4. **Resolve.**
     - **Nothing was applied**: close, no money moved.
     - **A wallet was credited**: debit up to the available balance (the ₹0 floor of D-2 applies), then either record the rest for collection or write it off with approval.
     - **A subscription is active**: end it now, or let the paid period run.
     - Finance chooses each rule. **Nothing is reversed automatically.**
  5. **Close.** Recorded with who, when and why; a second approver if UD-6 requires one.
  6. **Report.** Daily count of detected, open and closed external refunds; an alert if a case stays open for more than 24 h.
- **Recommendation (Engineering).** (a), with the workflow above.
- **Evidence still needed.** Who holds Dashboard refund rights today (Owner).
- **Blocks.** Settling external-refund cases; the refund policy text in the runbook.
- **If left open.** Detected cases stay open and are escalated. The late-notice risk above remains until detection ships.

## D-4 — Held payments resolved within 24 hours, by credit or refund only

- **Owner-approved 2026-10-19; Finance confirmation pending.**
- **Meaning.** A held payment has no financial effect until Finance resolves it, within **24 hours**, by credit or refund (details in UD-1).
- **Financial consequences.**
  - Driver money can sit at Razorpay for up to a day.
  - Finance needs staffing for a 24-hour target, including weekends.
- **Evidence available.** The "no financial effect while held" rule is built and tested.
- **Open point.** The "close, no money moved" outcome (UD-1).
- **Blocks.** The resolution process and screens.

## D-6 — Subscription payment that matches no open subscription

- **Owner-approved 2026-10-19; Finance confirmation pending (refund part).**
- **Meaning.** If a driver's subscription payment arrives for a purchase that was replaced or cancelled, a case opens automatically. **Any refund needs Finance approval.**
- **Why it matters now.** Review found that, today, such a late payment can be booked as subscription revenue with no plan activated. The Owner decided on 2026-10-21 (R6b) that replaced purchases are cancelled first, so such payments are held instead.
  - Subscription checkout stays OFF until that is built.
- **Financial consequences.** The driver's money is held until Finance refunds it; no revenue is recognized for it.
- **Blocks.** Refunds of these payments.

## D-2 — Commission wallet never below ₹0

- **Owner-approved 2026-10-19; Finance confirmation pending.**
- **Meaning.** A database rule refuses any balance below ₹0.
- **Financial consequences.**
  - A commission deduction or a correction (UD-7) can never create a negative balance. Any shortfall must be handled another way: recorded for collection, or written off.
  - Without the rule, only application logic protects the floor.
- **Evidence available.**
  - Dev data: no negative balances, but dev holds almost no wallet data, so this proves little.
  - Code review: commission deductions never go below zero today.
- **Evidence still needed.** The same check on staging and production (Q5). Not yet run: no access granted.
- **Blocks.** Adding the database rule.

## D-3 — Keep checking unpaid payments for 5 days, then expire

- **Owner-approved 2026-10-19; Finance confirmation pending.**
- **Meaning.**
  - An unpaid or failed payment is re-checked with Razorpay for **5 days** from creation.
  - It is marked expired only if Razorpay shows nothing captured or authorized.
  - A payment that succeeds later is still applied, and flagged.
- **Why 5 days.** Razorpay automatically captures authorized payments and refunds those not captured within its timeout, believed to be **3 days**. Sandbox testing showed automatic capture is on. **The timeout value cannot be read through Razorpay's API.**
- **Evidence still needed (Owner).** For both test and live mode, a dated record from the Razorpay Dashboard's payment-capture settings showing:
  - automatic capture enabled;
  - the timeout value;
  - the account (masked);
  - who checked.
- **Financial consequences.** Unpaid records close after 5 days. Late successes are never lost.
- **Blocks.** Expiring old unpaid payments.

## D-7 — A refund amount cannot change once reserved

- **Owner-approved 2026-10-19; Finance confirmation pending.** This restricts something Finance can do today.
- **Meaning.** Once a refund is reserved (sent, or about to be sent, to Razorpay), its amount is fixed.
- **Why.** Razorpay rejects a retried refund whose details changed: observed in sandbox testing on 2026-10-20 as a "409" error. A changed amount could leave a refund stuck "in progress".
- **Financial consequences.** To refund a different amount, Finance cancels the pending request (if still possible) and creates a new one.
- **Blocks.** Locking the refund amount.

## D-11 — No separate ledger posting key

- **Owner-approved 2026-10-19; Finance confirmation pending.** Non-blocking.
- **Meaning.**
  - Instead of a posting key on every ledger entry, duplicate postings are prevented by database rules on the records that cause them: one successful payment per purchase, one wallet credit per recharge, one review case per payment.
  - The ledger itself becomes append-only: corrections are new entries, never edits.
- **Financial consequences.** Duplicates are blocked at the source. An auditor may still prefer posting keys; that is deferred to the accounting feature.
- **Evidence available.** These rules were applied and tested on an isolated test database on 2026-10-21. They are not yet applied anywhere shared.

## UD-8 — Old payment records that stored the order reference instead of the payment reference

- **Question.** Older code stored Razorpay's _order_ reference where the _payment_ reference belongs. If such records exist, how are they repaired?
- **Options.**
  - (a) Look up each one's real payment at Razorpay (read-only) and record it.
  - (b) Leave them; refund manually if ever needed.
- **Why it matters.** Without a repair, a late Razorpay notice for such a payment would open a false review case.
- **Evidence.**
  - Dev data: **none found** (dev holds only test fixtures).
  - Staging and production: **not checked**. The check is ready; access has not been granted.
- **Decision needed only if** staging or production finds such records.

---

## What Finance is asked to do

1. Confirm whether Finance accepts each item marked "Finance" above. If not, name who decides.
2. For each accepted item: approve as written, choose an option, or amend.
3. Name a contact for the staging/production data checks that feed D-2 (balances), UD-8 (old records) and any paid-but-not-credited findings.
