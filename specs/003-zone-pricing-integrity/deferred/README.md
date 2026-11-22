# Deferred contract migrations

Constitution §16.2: the previous application version is still running during a
rollout, and still reads what these statements drop. Each file here is written
and reviewed, and is **deliberately not in `prisma/migrations/`** — a file in
that directory is applied by the next `migrate deploy`, which is exactly what
must not happen yet. Move a file into `prisma/migrations/` under a fresh
timestamp once its trigger has passed.

FR-047 requires the schedule to be named rather than merely intended. This is
the part of feature 003 that does not complete inside feature 003.

| File                               | Trigger                                                                                            | Owed since          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| `drop_referral_expiry_columns.sql` | One release after Phase 4 deploys                                                                  | Phase 4, 2026-08-29 |
| `drop_legacy_surge_geography.sql`  | One release after Phase 5 deploys **and** `surge_windows.service_zone_id` is non-null on every row | Phase 5, 2026-08-29 |
| `drop_dead_pricing_schema.sql`     | One release after Phase 6 deploys                                                                  | Phase 6, 2026-08-29 |

Before running any of them, re-run its pre-flight query against **production**.
A clean result on the test database proves nothing about production data.
