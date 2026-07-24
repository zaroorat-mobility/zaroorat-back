# Requirements Traceability Matrix

**Owner:** Product & QA · **Last reviewed:** 2026-07-06

This matrix is the **single view** that proves every business rule is implemented and tested —
nothing is orphaned (a rule with no requirement) and nothing is unjustified (a feature with no
rule). It links **Business rule (V2) → Functional requirement (V3) → User story (V3) → Test
(V12)**. Test IDs are placeholders until Volume 12 defines them; the column exists now so the
chain is complete by construction.

> **How to use it:** changing a business rule? Follow its row to see every FR, story, and test
> that must change with it. Reviewing a PR? Its FR should trace back to a rule and forward to a test.

---

## Rule → Requirement → Story → Test

| Business rule (V2)                       | Functional req (V3)                       | User story             | Test (V12)  |
| ---------------------------------------- | ----------------------------------------- | ---------------------- | ----------- |
| R-ACCOUNT-1 (OTP verify)                 | FR-AUTH-01/02/03                          | US-AUTH-01             | T-AUTH-01   |
| R-ACCOUNT-2/3 (one acct/role; dual role) | FR-AUTH-05                                | US-AUTH-01             | T-AUTH-02   |
| R-ACCOUNT-4 (suspension)                 | FR-AUTH-06                                | US-ADMIN-01            | T-AUTH-03   |
| R-KYC-1 (docs)                           | FR-KYC-01                                 | US-DRV-01              | T-KYC-01    |
| R-KYC-2 (approve before online)          | FR-KYC-02/03                              | US-DRV-01/02           | T-KYC-02    |
| R-KYC-3 (expiry blocks)                  | FR-KYC-04                                 | US-DRV-02              | T-KYC-03    |
| R-KYC-4 (vehicle mapping)                | FR-KYC-05                                 | US-DRV-02              | T-KYC-04    |
| R-AVAIL-1/2/3 (eligibility)              | FR-MATCH-01                               | US-MATCH-01            | T-MATCH-01  |
| R-AVAIL-4 (nearest+fairness)             | FR-MATCH-02                               | US-MATCH-01/02         | T-MATCH-02  |
| R-AVAIL-5 (no immediate re-offer)        | FR-MATCH-03                               | US-MATCH-01            | T-MATCH-03  |
| R-AVAIL-6 (radius/expiry)                | FR-MATCH-04                               | US-MATCH-01            | T-MATCH-04  |
| R-PRICE-1/2 (fare formula, min)          | FR-PRICE-01, FR-RIDE-02                   | US-RIDE-02             | T-PRICE-01  |
| R-PRICE-3 (surge cap+disclose)           | FR-PRICE-03                               | US-RIDE-02             | T-PRICE-02  |
| R-PRICE-4 (fare before confirm)          | FR-RIDE-02                                | US-RIDE-02             | T-PRICE-03  |
| R-PRICE-5 (honor quote)                  | FR-PRICE-04                               | US-RIDE-02             | T-PRICE-04  |
| R-PRICE-6 (config not code)              | FR-PRICE-02, FR-ADMIN-05                  | US-ADMIN-03            | T-PRICE-05  |
| R-TRIP-1 (state machine)                 | FR-TRIP-01, FR-RIDE-05, FR-MATCH-05       | US-TRIP-03             | T-TRIP-01   |
| R-TRIP-2 (pickup OTP)                    | FR-TRIP-02                                | US-TRIP-02             | T-TRIP-02   |
| R-TRIP-3 (record actuals)                | FR-TRIP-04                                | US-TRIP-03             | T-TRIP-03   |
| R-TRIP-4 (one settlement)                | FR-TRIP-05                                | US-TRIP-03, US-PAY-01  | T-TRIP-04   |
| R-TRIP-5 (terminal exclusivity)          | FR-TRIP-06                                | —                      | T-TRIP-05   |
| R-CANCEL-1 (cancel + reason)             | FR-CANCEL-01                              | —                      | T-CANCEL-01 |
| R-CANCEL-2/4 (fee + disclose)            | FR-CANCEL-02                              | —                      | T-CANCEL-02 |
| R-CANCEL-3 (driver cancel)               | FR-CANCEL-03                              | —                      | T-CANCEL-03 |
| R-PAY-1 (double-entry+tax)               | FR-PAY-01, FR-DATA-03                     | US-PAY-01              | T-PAY-01    |
| R-PAY-2/6 (no negative, atomic)          | FR-PAY-03                                 | US-PAY-02              | T-PAY-02    |
| R-PAY-3 (cash settlement)                | FR-PAY-02                                 | US-PAY-01              | T-PAY-03    |
| R-PAY-4 (payout traceable)               | FR-PAY-06                                 | US-PAY-03              | T-PAY-04    |
| R-PAY-5 (refund RBAC)                    | FR-PAY-05, FR-ADMIN-03                    | US-ADMIN-02            | T-PAY-05    |
| BR-8 (transparent earnings)              | FR-PAY-04                                 | US-PAY-03              | T-PAY-06    |
| R-RATE-1/3 (rate, immutable)             | FR-RATE-01/03                             | US-RATE-01             | T-RATE-01   |
| R-RATE-2 (low-rating review)             | FR-RATE-02                                | —                      | T-RATE-02   |
| R-SAFE-1 (share+SOS)                     | FR-SAFE-01/03                             | US-SAFE-01/02          | T-SAFE-01   |
| R-SAFE-2 (identity shown)                | FR-SAFE-02                                | US-TRIP-01             | T-SAFE-02   |
| R-SAFE-3/4 (incident log+retention)      | FR-SAFE-03/04                             | US-SAFE-02             | T-SAFE-03   |
| R-DATA-1 (append-only)                   | FR-DATA-01                                | —                      | T-DATA-01   |
| R-DATA-2 (admin audit)                   | FR-ADMIN-04, FR-KYC-03                    | US-ADMIN-01/02         | T-DATA-02   |
| R-DATA-3 (privacy/retention)             | FR-KYC-06, NFR-COMPLY-02                  | —                      | T-DATA-03   |
| A6.1 (connectivity resilience)           | FR-TRIP-07, FR-NOTIF-02, NFR-RESIL-01..05 | US-AUTH-01, US-TRIP-04 | T-RESIL-01  |
| GST (India tax)                          | FR-PAY-01, NFR-COMPLY-01                  | US-PAY-01              | T-PAY-01    |

---

## Coverage check

| Check                                                                               | Status                          |
| ----------------------------------------------------------------------------------- | ------------------------------- |
| Every **Must** business rule maps to ≥ 1 functional requirement                     | ✅ (see rows above)             |
| Every functional requirement traces to a business rule or explicit product decision | ✅                              |
| Every Must FR has a planned test ID                                                 | ✅ (tests defined in Volume 12) |
| Orphan rules (no FR)                                                                | none                            |
| Orphan FRs (no rule/decision)                                                       | none                            |

> Keep this matrix current: any new FR **must** add a row here in the same PR. A missing row is
> a review blocker — it means either an untraceable requirement or an untested rule.
