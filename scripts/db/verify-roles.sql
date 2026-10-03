-- Verifies the audit-trail role model from the catalog. Changes nothing (its scratch table is
-- temporary). Run as the schema owner
-- (the role migrations run as), after `prisma migrate deploy` and create-app-login.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v app_user=zaroorat_app -f scripts/db/verify-roles.sql
--
-- Prints PASS/FAIL per check and exits non-zero if any check fails.
-- Companion: scripts/db/verify-runtime-login.sql, run AS the runtime login, makes the live
-- attempts. docs/15_Security/database-roles.md explains the model.
\set ON_ERROR_STOP on
\if :{?app_user}
\else
  \set app_user zaroorat_app
\endif
SELECT set_config('verify.app_user', :'app_user', false);

DO $$
DECLARE
  app      text := current_setting('verify.app_user');
  owner_   text := current_user;
  failures text[] := '{}';
  t        record;
  missing  text;
BEGIN
  -- Each check: a description and whether it held.
  CREATE TEMP TABLE IF NOT EXISTS _verify (n serial, label text, ok boolean) ON COMMIT DROP;

  -- ── Migrations ────────────────────────────────────────────────────────────────
  INSERT INTO _verify (label, ok) SELECT 'migration ' || m || ' applied',
    EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = m
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  FROM unnest(ARRAY['20261001120000_admin_audit_append_only',
                    '20261002130100_admin_audit_truncate_guard_runtime_role']) AS m;

  -- ── Triggers: name, table, function, timing/level/events, ENABLE ALWAYS ──────
  -- tgtype bits: 1 ROW, 2 BEFORE, 8 DELETE, 16 UPDATE, 32 TRUNCATE.
  FOR t IN SELECT * FROM (VALUES
      ('admin_activity_logs', 'admin_activity_logs_append_only', 'reject_audit_mutation', 1 | 2 | 8 | 16),
      ('audit_field_changes', 'audit_field_changes_append_only', 'reject_audit_mutation', 1 | 2 | 8 | 16),
      ('admin_activity_logs', 'admin_activity_logs_no_truncate', 'reject_audit_truncate', 2 | 32),
      ('audit_field_changes', 'audit_field_changes_no_truncate', 'reject_audit_truncate', 2 | 32)
    ) AS x(tbl, trg, fn, typ)
  LOOP
    INSERT INTO _verify (label, ok) SELECT
      format('trigger %s on %s: %s(), %s, enabled ALWAYS', t.trg, t.tbl, t.fn,
             CASE WHEN t.typ & 32 <> 0 THEN 'BEFORE TRUNCATE per statement' ELSE 'BEFORE UPDATE OR DELETE per row' END),
      EXISTS (SELECT 1 FROM pg_trigger g
               WHERE g.tgrelid = format('public.%I', t.tbl)::regclass AND g.tgname = t.trg
                 AND NOT g.tgisinternal AND g.tgenabled = 'A'
                 AND g.tgfoid = format('public.%I()', t.fn)::regprocedure
                 AND g.tgtype::int = t.typ);
  END LOOP;

  -- ── Actor foreign key ─────────────────────────────────────────────────────────
  INSERT INTO _verify (label, ok) SELECT
    'admin_activity_logs.actor_id -> users(id) ON DELETE RESTRICT ON UPDATE RESTRICT',
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'admin_activity_logs_actor_id_fkey'
               AND conrelid = 'public.admin_activity_logs'::regclass
               AND confrelid = 'public.users'::regclass
               AND confdeltype = 'r' AND confupdtype = 'r');

  -- ── Owner (the role running this script) ─────────────────────────────────────
  INSERT INTO _verify (label, ok) SELECT format('owner %s owns both audit tables', owner_),
    (SELECT bool_and(pg_has_role(owner_, c.relowner, 'USAGE')) FROM pg_class c
      WHERE c.oid IN ('public.admin_activity_logs'::regclass, 'public.audit_field_changes'::regclass));
  INSERT INTO _verify (label, ok) SELECT format('owner %s can create in schema public (runs migrations)', owner_),
    has_schema_privilege(owner_, 'public', 'CREATE');

  -- ── Runtime group role ───────────────────────────────────────────────────────
  INSERT INTO _verify (label, ok) SELECT
    'zaroorat_app_runtime exists: NOLOGIN, not superuser, no CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS',
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime' AND NOT rolcanlogin
             AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
             AND NOT rolbypassrls);

  -- ── Runtime login ────────────────────────────────────────────────────────────
  INSERT INTO _verify (label, ok) SELECT
    format('%s exists: LOGIN, not superuser, no CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS', app),
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app AND rolcanlogin AND NOT rolsuper
             AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    INSERT INTO _verify (label, ok) SELECT format('%s is a member of zaroorat_app_runtime', app),
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime')
        AND pg_has_role(app, 'zaroorat_app_runtime', 'USAGE');
    INSERT INTO _verify (label, ok) SELECT
      format('%s neither owns nor can act as the owner of the audit tables (no ALTER, DROP, DISABLE TRIGGER)', app),
      NOT (SELECT bool_or(pg_has_role(app, c.relowner, 'MEMBER')) FROM pg_class c
            WHERE c.oid IN ('public.admin_activity_logs'::regclass, 'public.audit_field_changes'::regclass));
    INSERT INTO _verify (label, ok) SELECT format('%s cannot act as the owner role %s', app, owner_),
      app <> owner_ AND NOT pg_has_role(app, owner_, 'MEMBER');

    FOR t IN SELECT * FROM (VALUES ('admin_activity_logs'), ('audit_field_changes')) AS x(tbl) LOOP
      INSERT INTO _verify (label, ok) SELECT format('%s on %s: SELECT and INSERT only (no UPDATE, DELETE, TRUNCATE, TRIGGER)', app, t.tbl),
        has_table_privilege(app, format('public.%I', t.tbl), 'SELECT')
        AND has_table_privilege(app, format('public.%I', t.tbl), 'INSERT')
        AND NOT has_table_privilege(app, format('public.%I', t.tbl), 'UPDATE')
        AND NOT has_table_privilege(app, format('public.%I', t.tbl), 'DELETE')
        AND NOT has_table_privilege(app, format('public.%I', t.tbl), 'TRUNCATE')
        AND NOT has_table_privilege(app, format('public.%I', t.tbl), 'TRIGGER');
      INSERT INTO _verify (label, ok) SELECT format('PUBLIC has no UPDATE, DELETE or TRUNCATE on %s', t.tbl),
        NOT has_table_privilege('public', format('public.%I', t.tbl), 'UPDATE')
        AND NOT has_table_privilege('public', format('public.%I', t.tbl), 'DELETE')
        AND NOT has_table_privilege('public', format('public.%I', t.tbl), 'TRUNCATE');
    END LOOP;

    INSERT INTO _verify (label, ok) SELECT format('%s cannot read or write _prisma_migrations', app),
      NOT has_table_privilege(app, 'public._prisma_migrations', 'SELECT')
      AND NOT has_table_privilege(app, 'public._prisma_migrations', 'INSERT');
    INSERT INTO _verify (label, ok) SELECT format('%s cannot TRUNCATE users (no CASCADE into the audit tables)', app),
      NOT has_table_privilege(app, 'public.users', 'TRUNCATE');
    IF current_setting('server_version_num')::int >= 150000 THEN
      EXECUTE format($q$INSERT INTO _verify (label, ok) SELECT %L,
        NOT has_parameter_privilege(%L, 'session_replication_role', 'SET')$q$,
        app || ' cannot SET session_replication_role (the switch that silences triggers)', app);
    END IF;

    -- The app needs CRUD on every application table, or it fails at runtime instead.
    SELECT string_agg(DISTINCT tb.table_name, ', ') INTO missing
      FROM information_schema.tables tb
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
     WHERE tb.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND tb.table_name NOT IN ('_prisma_migrations', 'spatial_ref_sys', 'admin_activity_logs', 'audit_field_changes')
       AND NOT has_table_privilege(app, format('public.%I', tb.table_name), p.priv);
    INSERT INTO _verify (label, ok) SELECT
      format('%s has SELECT/INSERT/UPDATE/DELETE on every application table%s', app,
             CASE WHEN missing IS NULL THEN '' ELSE ' (missing: ' || missing || ')' END),
      missing IS NULL;
  END IF;

  FOR t IN SELECT * FROM _verify ORDER BY n LOOP
    RAISE NOTICE '% %', CASE WHEN t.ok THEN 'PASS' ELSE 'FAIL' END, t.label;
    IF t.ok IS NOT TRUE THEN failures := failures || t.label; END IF;
  END LOOP;
  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION '% role check(s) FAILED: %', cardinality(failures), array_to_string(failures, ' | ');
  END IF;
  RAISE NOTICE 'ALL ROLE CHECKS PASSED (owner %, runtime login %)', owner_, app;
END
$$;
