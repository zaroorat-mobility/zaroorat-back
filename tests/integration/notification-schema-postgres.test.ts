import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { db, resetState } from './helpers/harness.js';

/// The notification schema, as `prisma migrate deploy` builds it (CI builds the
/// test database exactly that way).
///
/// Regression for c7113a8: the Prisma schema declared `Notification.idempotencyKey`
/// and the consumer wrote it, but no migration created the column, so on any
/// database built from migrations every ride-notification insert failed — and the
/// consumer swallows that failure by design. Nothing here goes through the
/// repository: its find-before-insert would hide a missing unique index.

const PHASE_A_MIGRATIONS = [
  '20260924000000_user_device_revoked_at',
  '20260924010000_notification_retention_indexes',
  '20260924020000_notification_idempotency_key',
];

/// index name → must it be unique
const REQUIRED_INDEXES: Record<string, boolean> = {
  notifications_idempotency_key_key: true,
  notifications_created_at_idx: false,
  notifications_status_idx: false,
  notification_deliveries_created_at_idx: false,
  outbox_events_status_published_at_idx: false,
};

describe('notification schema from migrations (PostgreSQL)', () => {
  afterEach(async () => {
    await resetState();
  });

  it('the Phase A notification migrations are applied', async () => {
    const rows = await db().client.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const applied = new Set(rows.map((r) => r.migration_name));
    for (const name of PHASE_A_MIGRATIONS) assert.ok(applied.has(name), `${name} applied`);
  });

  it('notifications.idempotency_key and user_devices.revoked_at exist', async () => {
    const rows = await db().client.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'notifications' AND column_name = 'idempotency_key')
         OR (table_name = 'user_devices' AND column_name = 'revoked_at')`;
    assert.deepEqual(rows.map((r) => `${r.table_name}.${r.column_name}`).sort(), [
      'notifications.idempotency_key',
      'user_devices.revoked_at',
    ]);
  });

  it('every index the pipeline and the reconciliations rely on exists and is valid', async () => {
    const rows = await db().client.$queryRaw<
      Array<{ name: string; unique: boolean; valid: boolean }>
    >`
      SELECT c.relname AS name, i.indisunique AS unique, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ANY(${Object.keys(REQUIRED_INDEXES)}::text[])`;
    const found = new Map(rows.map((r) => [r.name, r]));
    for (const [name, unique] of Object.entries(REQUIRED_INDEXES)) {
      const index = found.get(name);
      assert.ok(index, `${name} exists`);
      assert.equal(index.valid, true, `${name} is valid`);
      assert.equal(index.unique, unique, `${name} unique=${unique}`);
    }
  });

  it('the database itself refuses a second notification with the same idempotency key', async () => {
    const user = await db().client.user.create({
      data: { phoneNumber: `+91${Math.floor(6_000_000_000 + Math.random() * 3_999_999_999)}` },
    });
    const key = `${randomUUID()}:ride.started:${user.id}:PUSH`;
    const insert = () => db().client.$executeRaw`
      INSERT INTO notifications (id, user_id, idempotency_key, status)
      VALUES (${randomUUID()}::uuid, ${user.id}::uuid, ${key}, 'QUEUED')`;

    assert.equal(await insert(), 1);
    await assert.rejects(insert(), (err: unknown) => {
      const text = String((err as Error).message) + JSON.stringify(err);
      return text.includes('23505') || text.includes('notifications_idempotency_key_key');
    });
  });
});
