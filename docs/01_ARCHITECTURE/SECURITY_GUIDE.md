# Security

> **Status:** 🟡 Draft · **Owner:** Engineering · **Last updated:** 2026-07-20
> **See also:** [System Architecture §8](./SYSTEM_ARCHITECTURE.md), [ADR-0008](./ADR/0008-idempotency-on-money-writes.md)

Security is a property of every endpoint, not a module. **Deny by default.**

---

## 1. Request pipeline

```
rate-limit → helmet/cors → auth (JWT verify) → role (authorize) → idempotency → service
```

## 2. Authentication

- Phone + **OTP** login; OTP is time-limited, single-use, and rate-limited per phone/device.
- **JWT**: short-lived access token + refresh token. Refresh rotates; revoked/blacklisted tokens are rejected.
- Failed OTP/login attempts are throttled and logged.
- Tokens carry the minimum claims (user id, roles) — no PII in the token.

## 3. Authorization

- Every endpoint **declares required roles**; `middleware/role.ts` enforces them. Missing declaration = no access.
- Users see **only their own** data. A rider cannot read another rider's trip; a driver sees only trips assigned to them.
- Ops/admin access to private data is **role-gated and audited** (who, what, when).
- 401 (unauthenticated) and 403 (unauthorized) are distinct and correct.

## 4. Input & output

- **Validate at the boundary** — JSON Schema on every route; untrusted input never reaches a service.
- Output is schema-constrained; never serialize whole DB rows blindly (no leaking internal fields).
- Parameterized queries only (Prisma) — no string-built SQL.

## 5. Secrets & config

- **No secrets in code or Git.** All via env, validated at boot (`config/env.schema.ts`); the app **fails fast** on invalid/missing config.
- Rotate credentials on exposure; `.env` is git-ignored; `.env.example` documents keys without values.

## 6. Money & idempotency

- Money-mutating POSTs require an `Idempotency-Key` (ADR-0008); `Payment.idempotencyKey` is uniquely constrained at the DB.
- Money mutations are transactional with an append-only ledger — every debit/credit is auditable.

## 7. PII & privacy

- Documents/media live in object storage behind **short-lived signed URLs** — never public, never in the DB as blobs.
- Location data is private: a driver's live position goes only to the paired rider during an active trip.
- Retention of PII and documents follows the per-market policy (🔴 open decision — see [Feature Catalog §5](../00_PROJECT/FEATURE_CATALOG.md)).

## 8. Transport & platform hardening

- `helmet` (secure headers), `cors` (allow-list origins), `rate-limit` on public and abuse-prone endpoints.
- **SOS is exempt** from rate limits and feature flags — safety cannot be throttled.
- TLS everywhere in transit; no plaintext credentials.

## 9. Auditing

- Append-only trails: `TripEvent`, `LedgerEntry`, `SosEvent`, and admin action logs.
- Security-relevant events (auth failures, role escalations, ops data access) are logged with `requestId`.

## 10. Abuse & fraud

- Rate-limit OTP, ride creation, and promo redemption.
- Promo abuse guards (self-referral, repeat use) enforced in `promotions` + DB unique constraints.
- Anomalies surface in `analytics` for review.

## 11. Dependencies & supply chain

- Review new dependencies (license, maintenance, size). Run vulnerability scans in CI.
- No unvetted third-party SDKs inside modules — vendors are behind interfaces (ADR-0007).

## Security checklist (per endpoint)

- [ ] Auth required and role declared (or explicitly public + rate-limited).
- [ ] Request & response schemas defined.
- [ ] Only the caller's own data is returned.
- [ ] Money/critical action requires `Idempotency-Key`.
- [ ] No secrets/PII in logs or errors.
- [ ] Audited if it touches money or another user's private data.
