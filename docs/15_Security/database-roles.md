# Database roles

The audit trail (`admin_activity_logs`, `audit_field_changes`) is append-only. Two layers
enforce that, and they only hold if the application does **not** connect as the role that
owns the schema.

| Role                                                      | Kind                                    | Used by                             | Can                                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner / migration role (e.g. `POSTGRES_USER`, RDS master) | LOGIN                                   | `prisma migrate deploy`, `db-roles` | Everything: DDL, triggers, grants                                                                                                                          |
| `zaroorat_app_runtime`                                    | NOLOGIN group                           | — (granted to the login below)      | `SELECT, INSERT, UPDATE, DELETE` on application tables; `SELECT, INSERT` only on the audit tables; no `TRUNCATE` anywhere; nothing on `_prisma_migrations` |
| `zaroorat_app` (name configurable: `APP_DB_USER`)         | LOGIN, member of `zaroorat_app_runtime` | API and worker `DATABASE_URL`       | Only what the group grants                                                                                                                                 |

## What enforces what

| Attempt                                                       | As the runtime login                        | As the owner                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE` / `DELETE` an audit row                              | Refused: no privilege (and the row trigger) | Refused by trigger `*_append_only`                                                                                            |
| `TRUNCATE` an audit table (directly or by `CASCADE`)          | Refused: no privilege                       | Refused by trigger `*_no_truncate`, unless `SET LOCAL zaroorat.allow_audit_truncate = 'on'` (the integration-test reset only) |
| `ALTER TABLE … DISABLE TRIGGER`, `DROP TRIGGER`, `DROP TABLE` | Refused: not owner                          | Possible — that is DDL, and belongs in a reviewed migration                                                                   |
| `SET session_replication_role = replica`                      | Refused: superuser only                     | Triggers are `ENABLE ALWAYS`, so they still fire                                                                              |
| Hard-delete a user who has audit rows                         | Refused: FK `ON DELETE RESTRICT`            | Same                                                                                                                          |

The owner can still remove the protections with DDL. That is unavoidable for the role that
owns the schema; the control is that the application never holds that role.

## Provisioning

Migrations `20261001120000_admin_audit_append_only` and
`20261002130100_admin_audit_truncate_guard_runtime_role` create the triggers, the
`zaroorat_app_runtime` group and its grants (including default privileges, so tables added
by later migrations are covered). The LOGIN user is created separately, because its
password comes from the secret store:

```sh
# Docker Compose (compose.prod.yml) — APP_DB_PASSWORD must be set in the environment
make migrate-prod              # runs `migrate`, then `db-roles`

# Any other environment (RDS, Kubernetes), as the owner, after migrate deploy.
# APP_DB_PASSWORD is read from the environment (psql 15+), never passed as an argument:
APP_DB_PASSWORD="$(<secret store>)" psql "$OWNER_DATABASE_URL" \
  -v app_user=zaroorat_app -f scripts/db/create-app-login.sql
```

Then point the application at the login:

- **Compose:** `compose.prod.yml` already does — the API and worker connect through
  pgbouncer as `APP_DB_USER`; `migrate` and `db-roles` connect directly as `POSTGRES_USER`.
- **Helm:** the `DATABASE_URL` in the `existingSecret` (`zaroorat-backend-secrets`) must
  use the runtime login. Run migrations with a separate owner `DATABASE_URL`, not the app's.

If the migration role lacks `CREATEROLE`, migration `20261002130100` logs a WARNING and
skips the role. Create it as a privileged user and re-run the `DO $$ … $$` block from that
migration:

```sql
CREATE ROLE zaroorat_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

## Verify

```sql
-- As the owner:
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('zaroorat_app', 'zaroorat_app_runtime');
SELECT has_table_privilege('zaroorat_app', 'admin_activity_logs', 'UPDATE'),   -- false
       has_table_privilege('zaroorat_app', 'admin_activity_logs', 'DELETE'),   -- false
       has_table_privilege('zaroorat_app', 'admin_activity_logs', 'TRUNCATE'), -- false
       has_table_privilege('zaroorat_app', 'admin_activity_logs', 'INSERT');   -- true
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid IN ('admin_activity_logs'::regclass, 'audit_field_changes'::regclass) AND NOT tgisinternal;
 -- four triggers, tgenabled = 'A' (always)
```

## Development and test

Local development and the integration tests still connect as the owner (the stock
postgres image's superuser), for convenience: the test harness has to `TRUNCATE` between
tests. The triggers apply there too. The runtime role exists in those databases and
`tests/integration/admin-audit-remediation.test.ts` exercises it with `SET ROLE`.
