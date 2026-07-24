# Security Testing

**Owner:** Engineering (Security + QA) · **Last reviewed:** 2026-07-06
**Realizes:** NFR-SEC-*, Volume 7 authz, Volume 9 RBAC — full threat model in Volume 14

Security testing verifies the controls the handbook specifies actually hold under attack. This is the
_testing_ view; the _policy and threat model_ are [Volume 14 (Security)](../15_Security/README.md).
For a money + PII + safety product, these tests are not optional.

---

## What we test (by category)

### 1. Authentication & session

| Test            | Asserts                                                    |
| --------------- | ---------------------------------------------------------- |
| `T-SEC-AUTH-01` | OTP brute-force is rate-limited + locked out (A-1)         |
| `T-SEC-AUTH-02` | expired/invalid/tampered JWT rejected (signature verified) |
| `T-SEC-AUTH-03` | refresh rotation detects reuse → revokes chain (A-3)       |
| `T-SEC-AUTH-04` | suspended user's tokens can't act (A-3, R-ACCOUNT-4)       |
| `T-SEC-AUTH-05` | tokens carry no secret/PII beyond claims; not logged       |

### 2. Authorization (the big one) — NFR-SEC-04

Authorization bugs are the most common and most damaging. We test **default-deny** and **ownership**
exhaustively:

| Test             | Asserts                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `T-SEC-AUTHZ-01` | every protected endpoint rejects unauthenticated calls (401)               |
| `T-SEC-AUTHZ-02` | **IDOR:** rider A cannot read/act on rider B's trip/wallet (→ 404)         |
| `T-SEC-AUTHZ-03` | driver cannot call rider-only endpoints and vice-versa                     |
| `T-SEC-AUTHZ-04` | **RBAC:** each `👮` admin endpoint requires its scope; missing scope → 403 |
| `T-SEC-AUTHZ-05` | hidden-in-UI actions still enforced server-side (Volume 9 golden rule)     |
| `T-SEC-AUTHZ-06` | WS: client can only subscribe to its own trip/driver channels              |

`T-SEC-AUTHZ-02/05` directly test the two rules we stated loudest: **"the client hides, the server
enforces"** (Volume 9) and **ownership returns 404 not 403** (Volume 7). These get automated,
adversarial tests — not a manual spot-check.

### 3. Input validation & injection

| Test             | Asserts                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `T-SEC-INPUT-01` | malformed/oversized bodies rejected (Pydantic, body-size limit)           |
| `T-SEC-INPUT-02` | SQL injection attempts inert (parameterized queries only — no string SQL) |
| `T-SEC-INPUT-03` | fuzzing endpoints yields typed 4xx, never a 5xx/stacktrace leak           |
| `T-SEC-INPUT-04` | admin inputs (XSS payloads) escaped/sanitized in the SPA                  |

### 4. Money & fraud abuse

| Test             | Asserts                                                       |
| ---------------- | ------------------------------------------------------------- |
| `T-SEC-MONEY-01` | can't replay a settlement to double-credit (idempotency, W-4) |
| `T-SEC-MONEY-02` | can't force negative wallet / overdraw (W-3)                  |
| `T-SEC-MONEY-03` | refund requires scope + reason + audit (R-PAY-5)              |
| `T-SEC-MONEY-04` | fabricated/duplicate trip completion rejected                 |

### 5. Rate limiting & abuse

| Test          | Asserts                                                   |
| ------------- | --------------------------------------------------------- |
| `T-SEC-RL-01` | OTP request/verify limits per phone + device (Volume 5/7) |
| `T-SEC-RL-02` | expensive endpoints throttled → 429 with Retry-After      |
| `T-SEC-RL-03` | edge rate limits (per-IP) active at Nginx (Volume 11 §04) |

---

## Automated scanning in CI (Volume 11 §02)

| Scan                           | Tool class                         | Gate                            |
| ------------------------------ | ---------------------------------- | ------------------------------- |
| **Dependency vulnerabilities** | Python + JS SCA (Dependabot-style) | fixable HIGH/CRITICAL fails     |
| **Container CVEs**             | Trivy/Grype (Volume 11 §01)        | HIGH/CRITICAL fails             |
| **Static analysis**            | Bandit (py), ESLint security rules | findings triaged                |
| **Secret scanning**            | git secret scanner                 | any committed secret fails hard |
| **DAST**                       | OWASP ZAP against staging          | key flows scanned               |

Secret scanning is **hard-fail**: a committed secret means _rotate it_ (not just delete the commit) —
git history is forever (Volume 1/14).

---

## OWASP coverage & pen testing

- We map tests to the **OWASP Top 10** (broken access control, injection, auth failures, etc.) — the
  authz suite above is our answer to the #1 category.
- **Manual/professional penetration testing** before major launches (external perspective catches
  what automated tests miss); findings tracked to closure (Volume 14).
- **Mobile-specific:** token storage in the keychain/keystore (not plain storage), no secrets in the
  bundle, certificate handling (Volume 8).

---

## Privacy & compliance testing (India / A1)

- **PII handling:** sensitive-field access is authorized + audited (NFR-SEC-03); tests assert masking
  in lists and access control on KYC documents.
- **Data retention:** tests verify retention/archival jobs don't violate immutability of financial/
  safety records (Volume 6 §06), and that deletion is _soft_ where required.
- **GST/tax:** money tests assert the tax component is recorded (T-PAY-01) — a compliance as well as
  correctness concern (NFR-COMPLY-01).

---

## Why security is testable here

The architecture makes these tests possible and meaningful: authz is a **single dependency** applied
uniformly (Volume 10 §04), so testing it is testing one mechanism, not scattered checks; the **error
envelope** (Volume 7) makes "no leak" assertable; **idempotency + DB constraints** (Volume 6/7) make
replay attacks testable; and **audit logs** (Volume 6) make accountability verifiable. Security here
is a property of the design, which is exactly why it can be tested rather than hoped for.
