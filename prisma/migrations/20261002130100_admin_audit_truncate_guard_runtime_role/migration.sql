-- FR-035, continued from 20261001120000_admin_audit_append_only.
--
-- 1. TRUNCATE. Row triggers do not fire on TRUNCATE, so the audit tables could still be
--    emptied in one statement — including by `TRUNCATE users ... CASCADE`, which reaches
--    them through the actor foreign key. A statement-level trigger refuses it.
--
--    The single escape hatch is a transaction-local setting the integration-test harness
--    sets before its reset (tests/integration/helpers/harness.ts):
--      SET LOCAL zaroorat.allow_audit_truncate = 'on'
--    It is not a privilege bypass: the runtime role below has no TRUNCATE privilege at
--    all, so for it the setting changes nothing. It only stops an owner truncating by
--    accident — an owner who means to can drop the trigger, which is DDL a migration
--    would record.
CREATE OR REPLACE FUNCTION reject_audit_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('zaroorat.allow_audit_truncate', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: TRUNCATE refused', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER admin_activity_logs_no_truncate
  BEFORE TRUNCATE ON "admin_activity_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();

CREATE TRIGGER audit_field_changes_no_truncate
  BEFORE TRUNCATE ON "audit_field_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();

-- 2. ENABLE ALWAYS: the triggers also fire under `session_replication_role = replica`,
--    the setting that otherwise silences ordinary triggers.
ALTER TABLE "admin_activity_logs" ENABLE ALWAYS TRIGGER admin_activity_logs_append_only;
ALTER TABLE "admin_activity_logs" ENABLE ALWAYS TRIGGER admin_activity_logs_no_truncate;
ALTER TABLE "audit_field_changes" ENABLE ALWAYS TRIGGER audit_field_changes_append_only;
ALTER TABLE "audit_field_changes" ENABLE ALWAYS TRIGGER audit_field_changes_no_truncate;

-- 3. Runtime role. The application must not connect as the role that owns the schema:
--    an owner (or superuser) can disable or drop these triggers, truncate, alter and
--    drop. `zaroorat_app_runtime` is a NOLOGIN group role holding exactly the privileges
--    the running application needs; the deployment creates a LOGIN user in it
--    (scripts/db/create-app-login.sql) and points the API's DATABASE_URL at that user,
--    while migrations keep running as the owner. Credentials never live in a migration.
--
--    It can read and write application tables, but not UPDATE, DELETE or TRUNCATE the
--    audit tables, and — not being owner or superuser — cannot ALTER/DROP them or their
--    triggers, or set session_replication_role.
--
--    Creating a role needs CREATEROLE. A migration role without it gets a WARNING and the
--    rest of the migration still applies; the role must then be created by an operator
--    and this block re-run (docs/15_Security/database-roles.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime') THEN
    BEGIN
      CREATE ROLE zaroorat_app_runtime
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'zaroorat_app_runtime was not created: the migration role lacks CREATEROLE. See docs/15_Security/database-roles.md.';
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO zaroorat_app_runtime', current_database());
    GRANT USAGE ON SCHEMA public TO zaroorat_app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zaroorat_app_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO zaroorat_app_runtime;
    -- Tables and sequences later migrations create get the same CRUD grant.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zaroorat_app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO zaroorat_app_runtime;
    -- Append-only for the application, whatever the defaults above say.
    REVOKE UPDATE, DELETE, TRUNCATE ON "admin_activity_logs", "audit_field_changes"
      FROM zaroorat_app_runtime;
    -- Migration history is the owner's business.
    REVOKE ALL ON "_prisma_migrations" FROM zaroorat_app_runtime;
  END IF;
END
$$;
