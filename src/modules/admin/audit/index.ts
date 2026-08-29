import type { ProviderClient } from '@core/database/index.js';
import type { AuditAction, Prisma } from '../../../generated/prisma/index.js';

/// FR-035. Anything that can write an `admin_activity_logs` row — the client or a
/// transaction handle. Audit writes belong inside the transaction that made the
/// change, so a rolled-back mutation leaves no record claiming it happened.
export type AuditWriter = Pick<ProviderClient, 'adminActivityLog'>;

export interface AdminAuditEntry {
  actorId?: string | undefined;
  action: AuditAction;
  entityType: string;
  entityId?: string | undefined;
  summary?: string | undefined;
  /// State before the change, or undefined on a create.
  before?: unknown;
  /// State after the change, or undefined on a delete.
  after?: unknown;
}

/// `Prisma.Decimal` and `Date` both carry a `toJSON`, so a round-trip through
/// `JSON` is enough to make a DTO storable in a `Json` column. Anything that
/// cannot survive it (a cycle) is dropped rather than failing the mutation.
function jsonSafe(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

/// Record an admin write against the existing `AdminActivityLog` table.
///
/// The four admin modules that already audit (driver, rider, vehicle,
/// application) each inline their own `adminActivityLog.create`. This is the
/// same row, written from one place, so the geographic and pricing surfaces do
/// not each invent a shape.
///
/// Before/after go into `metadata` rather than into per-field `AuditFieldChange`
/// rows: the requirement is that the previous and next state are recoverable,
/// and nothing in the product reads a field-level diff. That table stays unused
/// until something does.
///
/// Every caller writes inside the transaction that made the change, so a failed
/// audit write rolls the change back with it. That is deliberate: a mutation the
/// system cannot account for should not land.
export async function recordAdminAction(db: AuditWriter, entry: AdminAuditEntry): Promise<void> {
  const metadata = {
    ...(jsonSafe(entry.before) !== undefined ? { before: jsonSafe(entry.before) } : {}),
    ...(jsonSafe(entry.after) !== undefined ? { after: jsonSafe(entry.after) } : {}),
  };

  await db.adminActivityLog.create({
    data: {
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
      action: entry.action,
      entityType: entry.entityType,
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  });
}
