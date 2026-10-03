-- Live check of the runtime login: run AS the login the API and worker use (the role in
-- the app's DATABASE_URL), never as the owner:
--
--   psql "$DATABASE_URL" -f scripts/db/verify-runtime-login.sql
--
-- Attempts every change the role must not be able to make to the audit trail, and an
-- INSERT it must be able to make. Safe against production: every attempt runs in its own
-- subtransaction that is always rolled back — even one that was wrongly allowed — and
-- lock_timeout keeps any attempt from waiting on live traffic. Nothing persists.
-- Prints PASS/FAIL per attempt and exits non-zero if any check fails.
\set ON_ERROR_STOP on

DO $$
DECLARE
  failures text[] := '{}';
  p        record;
  outcome  text;
  expected text;
  owner_   name;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  SELECT pg_get_userbyid(relowner) INTO owner_ FROM pg_class WHERE oid = 'public.admin_activity_logs'::regclass;

  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    failures := failures || format('%s is a superuser', current_user);
  END IF;

  -- expect_allowed, statement.
  FOR p IN SELECT * FROM (VALUES
      (true,  $s$INSERT INTO admin_activity_logs (id, action, entity_type, summary) VALUES (gen_random_uuid(), 'UPDATE', 'verify_probe', 'rolled back')$s$),
      (true,  'SELECT count(*) FROM admin_activity_logs WHERE false'),
      (false, 'UPDATE admin_activity_logs SET summary = summary WHERE false'),
      (false, 'DELETE FROM admin_activity_logs WHERE false'),
      (false, 'TRUNCATE admin_activity_logs'),
      (false, 'UPDATE audit_field_changes SET new_value = new_value WHERE false'),
      (false, 'DELETE FROM audit_field_changes WHERE false'),
      (false, 'TRUNCATE audit_field_changes'),
      (false, 'TRUNCATE users CASCADE'),
      (false, 'ALTER TABLE admin_activity_logs ADD COLUMN verify_probe int'),
      (false, 'ALTER TABLE audit_field_changes ADD COLUMN verify_probe int'),
      (false, 'ALTER TABLE admin_activity_logs DISABLE TRIGGER admin_activity_logs_append_only'),
      (false, 'ALTER TABLE admin_activity_logs DISABLE TRIGGER admin_activity_logs_no_truncate'),
      (false, 'ALTER TABLE audit_field_changes DISABLE TRIGGER audit_field_changes_append_only'),
      (false, 'ALTER TABLE audit_field_changes DISABLE TRIGGER audit_field_changes_no_truncate'),
      (false, 'DROP TRIGGER admin_activity_logs_append_only ON admin_activity_logs'),
      (false, 'DROP TRIGGER audit_field_changes_append_only ON audit_field_changes'),
      (false, 'DROP TABLE admin_activity_logs'),
      (false, $s$SELECT set_config('session_replication_role', 'replica', true)$s$),
      (false, format('SET LOCAL ROLE %I', owner_))
    ) AS x(expect_allowed, stmt)
  LOOP
    BEGIN
      EXECUTE p.stmt;
      -- It ran: undo it by aborting this subtransaction, and remember that it was allowed.
      RAISE EXCEPTION USING ERRCODE = 'P0V01';
    EXCEPTION
      WHEN SQLSTATE 'P0V01' THEN outcome := 'allowed';
      WHEN insufficient_privilege THEN outcome := 'refused';  -- 42501: no privilege / not owner
      -- Anything else means the privilege check did not stop it (or it could not run).
      WHEN OTHERS THEN outcome := 'error ' || SQLSTATE;
    END;
    expected := CASE WHEN p.expect_allowed THEN 'allowed' ELSE 'refused' END;
    IF outcome = expected THEN
      RAISE NOTICE 'PASS %: %', outcome, p.stmt;
    ELSE
      RAISE NOTICE 'FAIL % (expected %): %', outcome, expected, p.stmt;
      failures := failures || format('%s: %s', outcome, p.stmt);
    END IF;
  END LOOP;

  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'runtime login % FAILED % check(s): %', current_user, cardinality(failures),
      array_to_string(failures, ' | ');
  END IF;
  RAISE NOTICE 'ALL RUNTIME-LOGIN CHECKS PASSED for %', current_user;
END
$$;
