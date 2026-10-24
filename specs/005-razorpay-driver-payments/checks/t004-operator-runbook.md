# Operator Runbook — T004 Read-Only Data Checks (staging, production)

**Feature**: `005-razorpay-driver-payments` · **Task**: T004 (decision D-9) · **Prepared**: 2026-10-21 · **Status**: staging **BLOCKED**, production **BLOCKED** (prerequisites below)

**For**: the database operator who runs the checks.

**What it does.**

- It is **read-only**: no migration, no write, no switch change, no data copied out of the environment.
- It answers four questions:
  1. Is the data clean enough for migration `20261021120000_razorpay_payment_safeguards` (T020)?
  2. Are any inconsistencies genuine, or seed fixtures?
  3. Does historical payment data need the UD-8 repair (Q4)?
  4. What does the API's database role really have permission to do (Q10)?

**The file.** [`t004-readonly-checks.sql`](./t004-readonly-checks.sql), 198 lines. Reviewed version, SHA-256:

```
a56b1367479daeb8caa94005b41aba74bbb38269867d9f9669627a35e146dbad
```

Run only this version. If the hash differs, stop and get the change reviewed.

**Safety.**

- The file opens `BEGIN READ ONLY`, sets `statement_timeout 60s`, `lock_timeout 5s` and `idle_in_transaction_session_timeout 120s`, and ends with `ROLLBACK`.
- It prints counts and categories only. It never prints ids, names, phone numbers, emails, amounts per person, payloads, or setting values other than a provider name.

---

## 1. Prerequisites (both environments)

All must be true before anything runs. A missing item means the environment stays **BLOCKED**.

| #   | Prerequisite                                                                                                                                                             | Who provides it | Status 2026-10-21                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------- |
| P1  | Written Owner approval naming the environment, the operator and the date                                                                                                 | Owner           | Pending (the Phase 3A authorization asks for this runbook, not for the runs) |
| P2  | Network path to the environment's database (VPN or bastion)                                                                                                              | DevOps          | Not available on this workstation                                            |
| P3  | **Login A**: a read-only login or a read replica, for Q1–Q9, Q11, M1–M4. No secret is pasted into chat, tickets or the repository                                        | DevOps          | Not available                                                                |
| P4  | **Login B**: the API's own `DATABASE_URL` role, for Q10/Q10b only (decision D-9: "run through the API's own `DATABASE_URL`"). Used inside the same read-only transaction | DevOps          | Not available                                                                |
| P5  | `psql` client ≥ 13; the repository at a commit containing the reviewed file; `sha256sum`                                                                                 | Operator        | —                                                                            |
| P6  | Expected identity values for the environment: database name, host or replica name, migration count and latest migration from the deployment record                       | DevOps          | Not recorded yet                                                             |
| P7  | A restricted place for the raw output (Finance/Ops-internal); only the summary goes into research.md                                                                     | Owner           | To be named                                                                  |
| P8  | A quiet window (production): the M1 exact counts scan the payment tables once                                                                                            | Operator        | —                                                                            |

---

## 2. Procedure

**Step 1 — Verify the file.**

```
sha256sum specs/005-razorpay-driver-payments/checks/t004-readonly-checks.sql
```

It must equal the hash above. Otherwise **stop**.

**Step 2 — Verify the target with login A, before any check.** Run only the identity query:

```
psql "<login A URL>" -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT current_database(), current_user, session_user, inet_server_addr(), inet_server_port(), current_setting('server_version'), pg_is_in_recovery(), current_setting('transaction_read_only'), (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), (SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL); ROLLBACK;"
```

**Stop** if any of these is true:

- the database, host, migration count or latest migration differ from P6;
- `transaction_read_only` is not `on`;
- the login can be identified as an application owner or superuser when a read-only login was promised (check with Q10b afterwards and discard the run if so).

**Step 3 — Run the checks with login A.**

```
psql "<login A URL>" -X -v ON_ERROR_STOP=1 -P pager=off -f specs/005-razorpay-driver-payments/checks/t004-readonly-checks.sql > <restricted path>/t004-<env>-<date>.txt
```

The output must end with `ROLLBACK`. Any `ERROR` line means the run is void. Fix the cause (for example a timeout), never edit the file ad hoc.

**Step 4 — Run Q10/Q10b with login B (the API's role).** The same file can be used; only the Q10 and Q10b sections are recorded from this run, because they describe _the connecting role_. Same stop rules.

**Step 5 — Record.**

- Copy the summary values (counts, true/false) into the research.md Verification log, one row per check group, environment named.
- Raw output stays in P7.
- Never paste connection strings, hosts with credentials, or any id.

---

## 3. Reading the results

| Check                | Acceptable                                                                                                                                                                                                          | If not                                                                                                                                                                                                                                                                 | Escalate to                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| TARGET               | Matches P6; `transaction_read_only = on`                                                                                                                                                                            | **Stop**                                                                                                                                                                                                                                                               | Owner                        |
| Q1, Q3, Q4a, Q9      | 0                                                                                                                                                                                                                   | T020 cannot be applied there; the matching index build would fail. Finance-approved remediation first                                                                                                                                                                  | Owner + Finance              |
| Q2 / Q6              | 0 genuine (Q2b/Q6c split)                                                                                                                                                                                           | Each genuine row group is a possible paid-not-credited or paid-without-plan case. **Finance remediation is recorded before any migration.** Seed-fixture rows in staging/production are themselves an anomaly (the dev seed should never run there): report separately | Finance; Owner for seed rows |
| Q4b / **Q4c**        | `ud8_work_indicated = false`                                                                                                                                                                                        | **UD-8 needed**: rows that store an order id, or no `pay_` id, need the historical compatibility work (phase2-risk-review.md R5) before any late webhook can be handled without false review cases                                                                     | Finance + Engineering (UD-8) |
| Q5                   | 0                                                                                                                                                                                                                   | D-2's CHECK (T020b) cannot be added                                                                                                                                                                                                                                    | Finance                      |
| Q7                   | 0, or each type explained                                                                                                                                                                                           | Requeue under D-5 (Ops role, audited) only after review                                                                                                                                                                                                                | Operations                   |
| Q8                   | 0                                                                                                                                                                                                                   | Unbalanced books: Finance remediation before any migration                                                                                                                                                                                                             | Finance                      |
| Q10 / Q10b (login B) | Not superuser; **not** owner of the financial tables; member of `zaroorat_app_runtime`; UPDATE/DELETE/TRUNCATE on `payment_ledger_entries` and `driver_commission_wallet_transactions` will be **false after T020** | If superuser or owner: the REVOKE layer protects nothing; only the triggers do, and an owner can drop them. **SEC-7 is escalated**, tracked as U11                                                                                                                     | Owner + DevOps               |
| Q11a/b/c             | Recorded                                                                                                                                                                                                            | Sizes the first T061/T062 runs. UD-11 if `open_customer_topups_on_razorpay` > 0                                                                                                                                                                                        | Owner (UD-11)                |
| M1 / M1b             | Recorded                                                                                                                                                                                                            | Decides `CONCURRENTLY` pre-building (migration-readiness checklist, item E) and the window                                                                                                                                                                             | Operator                     |
| M2                   | 0, 0, 0                                                                                                                                                                                                             | A partial earlier attempt exists: investigate before any migration                                                                                                                                                                                                     | Operator                     |
| M3                   | `reject_audit_mutation = 1`                                                                                                                                                                                         | Earlier audit migrations missing: T020 would fail                                                                                                                                                                                                                      | Operator                     |
| M4                   | 0, 0                                                                                                                                                                                                                | New statuses already present: investigate                                                                                                                                                                                                                              | Engineering                  |

**Seed versus genuine rows.**

- The development seed writes `gi_seed_…` order ids and `seed-…` idempotency keys. Q2b/Q6c count those separately.
- On dev (2026-10-21) all Q2/Q6b rows were seed fixtures. On staging/production, **genuine rows are the only ones that matter financially**. Seed rows mean the seed ran where it should not, which is an operational finding, not a payment one.

---

## 4. Stop conditions (any one ends the run)

- The file hash differs from the reviewed hash.
- Environment identity does not match P6, or cannot be verified.
- The session is not read-only, or `ROLLBACK` is missing from the output.
- Any `ERROR` line.
- The operator would need to copy data out of the environment, print ids or personal data, or share a credential to proceed.
- No written approval (P1) for that environment.

---

## 5. Current status

| Environment             | Status                                                            | Missing                    |
| ----------------------- | ----------------------------------------------------------------- | -------------------------- |
| dev (`zaroorat`, local) | **Run** 2026-10-21 (Phase 3 and Phase 3A); results in research.md | —                          |
| staging                 | **BLOCKED**                                                       | P1, P2, P3, P4, P6, P7     |
| production              | **BLOCKED**                                                       | P1, P2, P3, P4, P6, P7, P8 |

No staging or production result exists. None may be inferred from dev.
