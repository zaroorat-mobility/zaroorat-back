# Secrets, Encryption & Data Protection

**Owner:** Engineering (Security) · **Last reviewed:** 2026-07-06
**Realizes:** NFR-SEC-01/05, NFR-COMPLY-02, R-DATA-3, Volume 6 §06

Protecting the data at rest and in transit, managing the secrets that guard it, and honoring the
privacy obligations that come with holding Indians' personal data (DPDP Act). This is where "we hold
sensitive data" becomes concrete controls.

---

## Secrets management

**Rule: secrets never live in code, git, images, logs, or client bundles.** (Volume 1/10/11.)

| Secret                 | Where it lives               | Rotation                                                  |
| ---------------------- | ---------------------------- | --------------------------------------------------------- |
| `jwt_secret`           | secret manager → runtime env | rotate on suspicion; supports key-id for rolling rotation |
| DB / Redis credentials | secret manager → runtime env | periodic + on incident                                    |
| SMS/maps/payment keys  | secret manager → runtime env | per provider; scoped/least-privilege                      |
| CI/CD deploy creds     | GitHub OIDC / scoped tokens  | short-lived, least privilege                              |
| TLS certs              | managed / auto-renewed       | automatic                                                 |

- **Injection at runtime:** the app reads secrets from env (via `Settings`, Volume 10 §03); Kubernetes
  sources them from a secret manager (Volume 11 §03). The code never knows _where_ they came from.
- **Rotation is a config change + restart**, not a code change — because config is external
  (Volume 10 §03).
- **Exposure response:** a leaked secret is **rotated**, not just deleted from git — history is
  forever (Volume 1). **Secret scanning hard-fails CI** (Volume 11/12) to catch it before merge.
- **Client secrets don't exist:** only `EXPO_PUBLIC_*`/`VITE_*` non-secret values ship to clients;
  map keys embedded in clients are **restricted/quota-limited** so a leaked one is low-value
  (Volume 8).

---

## Encryption

| State                          | Control                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **In transit**                 | **TLS everywhere** at the edge (NFR-SEC-01); modern ciphers; HSTS; WSS for realtime (Volume 11 §04) |
| **At rest — database**         | managed-Postgres encryption at rest                                                                 |
| **At rest — object storage**   | KYC docs/media encrypted; access-controlled (Volume 6)                                              |
| **At rest — sensitive fields** | especially-sensitive PII (Aadhaar/PAN) encrypted/tokenized at the application layer where warranted |
| **Backups**                    | encrypted (Volume 11 §06)                                                                           |
| **Secrets at rest**            | in the secret manager (KMS-backed)                                                                  |

Internal cluster traffic is on the private network; service-to-service **mTLS** is a maturity step as
the system grows (Volume 11 §04).

---

## Data classification

Knowing sensitivity drives the control applied:

| Class                | Examples                                                | Handling                                                            |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| **Highly sensitive** | Aadhaar/PAN, KYC docs, precise location history, ledger | encrypt, strict RBAC, **audited access**, minimize, tight retention |
| **Sensitive (PII)**  | phone, name, trip history                               | RBAC, masked in lists, audited where needed                         |
| **Internal**         | pricing config, ops data                                | RBAC                                                                |
| **Public**           | app content                                             | —                                                                   |

- **Sensitive-field access is authorized _and audited_** (NFR-SEC-03) — viewing a KYC document is
  logged, not just editing one (Volume 9).
- **Masking:** lists show partial data (e.g. masked phone); full data only on an authorized detail
  view.

---

## Privacy by design — India DPDP Act

Zaroorat Ride processes personal data of individuals in India, governed by the **Digital Personal
Data Protection (DPDP) Act, 2023** and applicable rules. Our posture:

| DPDP principle               | How we honor it                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| **Purpose limitation**       | collect data for stated purposes (ride, safety, KYC, payment) only                        |
| **Data minimization**        | collect only what a purpose needs; don't broadcast location when not on a trip (Volume 8) |
| **Consent & notice**         | clear notice at collection (KYC, location, notifications); consent for processing         |
| **Storage limitation**       | retention policies + archival/deletion jobs (Volume 6 §06); don't keep forever            |
| **Security safeguards**      | the controls in this volume (encryption, access control, audit)                           |
| **Rights of the individual** | support access/correction/erasure requests within legal bounds                            |
| **Breach handling**          | detect, contain, and **notify** as required (Volume 14 §05)                               |

> **Tension with immutability:** financial and safety records are append-only (Volume 6, R-DATA-1),
> which can conflict with an erasure request. We resolve this by **erasing/anonymizing personal
> identifiers** where legally permissible while **retaining the immutable financial/safety record**
> as law requires (tax, dispute, safety). Exact treatment is confirmed with legal counsel; the data
> model separates identifiers from the immutable facts to make this possible.

Aadhaar specifically carries heightened legal obligations — it's treated as **highly sensitive**,
encrypted, minimally used, and tightly access-controlled.

---

## Retention & deletion

- **Policy-driven retention** per data class, enforced by scheduled jobs (Volume 6 §06 / Volume 13
  §05). Location history is kept long enough for safety investigation (R-SAFE-4), then archived/
  purged per policy.
- **Soft delete** for user-facing "delete" (recoverable, preserves referential integrity, Volume 6);
  **archival** moves cold data to cheaper storage but keeps it recoverable within policy.
- Retention **never overrides** the immutability of what compliance/safety require — we _archive_,
  we don't destroy evidence (Volume 6/11).

---

## Logging & PII

- Structured logs carry `request_id` and safe context — **no secrets, no unnecessary PII** (Volume
  10/11). Where a user id is logged for debugging, it's the internal id, not the phone/Aadhaar.
- Error responses never leak internal detail (Volume 7 §04) — no stack traces, no data, to clients.

---

## Traceability

| Control                                                | Realizes                |
| ------------------------------------------------------ | ----------------------- |
| Secrets external, rotated, scan-gated                  | Volume 1/10/11, NFR-SEC |
| TLS in transit; encryption at rest                     | NFR-SEC-01/05           |
| Data classification + sensitive-read audit             | NFR-SEC-03, R-DATA-2    |
| DPDP: minimization/consent/retention/rights            | NFR-COMPLY-02, R-DATA-3 |
| Identifier/fact separation for erasure vs immutability | R-DATA-1 + DPDP         |
