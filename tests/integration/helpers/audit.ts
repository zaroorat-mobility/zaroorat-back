import { db } from './harness.js';

const UUID = /^[0-9a-f-]{36}$/i;

/// Makes Postgres refuse every `admin_activity_logs` insert for `entityType` — or, with
/// `entityId`, for that one entity — the way a full disk or a constraint failure would.
/// A test then proves the business write in the same transaction rolled back with it.
/// Pair with `allowAuditWrites` in `afterEach`, so a failing test cannot leave the
/// trigger behind for the next one.
export async function refuseAuditWrites(entityType: string, entityId?: string): Promise<void> {
  if (!/^[a-z_]+$/.test(entityType)) throw new Error(`bad entity type: ${entityType}`);
  if (entityId !== undefined && !UUID.test(entityId)) throw new Error(`bad id: ${entityId}`);
  const onlyThis = entityId ? ` AND NEW.entity_id = '${entityId}'::uuid` : '';
  await db().client.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION test_refuse_audit_write() RETURNS trigger LANGUAGE plpgsql AS
     $$ BEGIN RAISE EXCEPTION 'audit write refused by test'; END $$`,
  );
  await allowAuditWrites();
  await db().client.$executeRawUnsafe(
    `CREATE TRIGGER test_refuse_audit_write BEFORE INSERT ON admin_activity_logs
     FOR EACH ROW WHEN (NEW.entity_type = '${entityType}'${onlyThis})
     EXECUTE FUNCTION test_refuse_audit_write()`,
  );
}

export async function allowAuditWrites(): Promise<void> {
  await db().client.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS test_refuse_audit_write ON admin_activity_logs',
  );
}

export function auditRows(entityType: string, entityId?: string) {
  return db().client.adminActivityLog.findMany({
    where: { entityType, ...(entityId ? { entityId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

/// `metadata.result` of each row, for external actions logged as REQUESTED → outcome.
export function results(rows: Array<{ metadata: unknown }>): string[] {
  return rows.map((r) => String((r.metadata as { result?: string } | null)?.result));
}

/// A uuid nobody is: what a client would put in the body to claim someone else's action.
export const SPOOFED_ACTOR_ID = '00000000-0000-7000-8000-00000000beef';
