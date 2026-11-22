-- FR-035. Audit rows are append-only, enforced by the database rather than by the
-- absence of application code that edits them.
--
-- A trigger, not REVOKE: every deployment (compose.dev.yml, compose.prod.yml) runs the
-- application as POSTGRES_USER, which owns these tables and is a superuser in the stock
-- postgres image. Privileges do not bind an owner or a superuser; a row trigger fires
-- for every role. Getting past it takes deliberate DDL (ALTER TABLE ... DISABLE
-- TRIGGER, or session_replication_role), which needs those same rights — closing that
-- gap needs a separate, non-owning runtime role, which is a deployment change.
--
-- TRUNCATE is not covered: row triggers do not fire on it, the integration harness
-- resets the database with TRUNCATE ... CASCADE, and no application path truncates.

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER admin_activity_logs_append_only
  BEFORE UPDATE OR DELETE ON "admin_activity_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TRIGGER audit_field_changes_append_only
  BEFORE UPDATE OR DELETE ON "audit_field_changes"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Actor identity. ON DELETE SET NULL erased who made a change the moment their user row
-- was deleted — and, under the trigger above, would now make that delete fail with an
-- "append-only" error instead. RESTRICT states the actual rule: a user who has acted as
-- an admin cannot be hard-deleted, so `actor_id` always resolves. No existing path
-- changes: the application never hard-deletes users (account erasure anonymises the row
-- in place and keeps its id), and a user with no audit rows deletes as before.
ALTER TABLE "admin_activity_logs" DROP CONSTRAINT "admin_activity_logs_actor_id_fkey";
ALTER TABLE "admin_activity_logs" ADD CONSTRAINT "admin_activity_logs_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
