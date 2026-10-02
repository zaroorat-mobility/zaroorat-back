import type { FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import type { ProviderClient } from '@core/database/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { AuditAction, Prisma } from '../../../generated/prisma/index.js';
import { safeErrorSummary } from './safe-error.js';

export { redactSensitive, safeErrorSummary, type SafeErrorSummary } from './safe-error.js';

/// Who made an admin change and from where, taken from the authenticated request.
export interface AuditActor {
  actorId: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export function auditActor(request: FastifyRequest): AuditActor {
  const userAgent = request.headers['user-agent'];
  return {
    actorId: callerId(request),
    ...(request.ip ? { ipAddress: request.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent: userAgent.slice(0, 512) } : {}),
  };
}

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
  /// Stored in `metadata.result`. A row written inside the change's transaction is a
  /// committed change: SUCCESS. REQUESTED and FAILED belong to `auditExternalAction`,
  /// for changes that live outside PostgreSQL.
  result?: 'SUCCESS' | 'REQUESTED' | 'FAILED' | 'NO_OP' | undefined;
  /// The operator's free-text reason, stored in `metadata.notes` — where the driver and
  /// rider timelines read it from.
  notes?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/// Tables whose admin UPDATEs lock the row before reading their `before`.
type AuditedTable =
  | 'users'
  | 'admin_sessions'
  | 'drivers'
  | 'promotions'
  | 'promo_campaigns'
  | 'coupon_batches'
  | 'promo_banners'
  | 'audience_segments'
  | 'referral_programs'
  | 'referral_milestones'
  | 'referral_codes'
  | 'cancellation_policies'
  | 'invoice_templates'
  | 'feature_flags'
  | 'driver_documents'
  | 'vehicle_documents';

/// Holds the row until the transaction ends, so the `before` an UPDATE records is the
/// state its write replaced — not one a concurrent edit had already overwritten.
export async function lockForAudit(
  tx: TransactionClient,
  table: AuditedTable,
  id: string,
): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1::uuid FOR UPDATE`, id);
}

/// For state that is not one row — a settings category, the settlement-batch sequence:
/// a transaction-scoped advisory lock on `key`, released at commit or rollback. Two
/// writers to the same resource queue here, so each one's `before` is what it replaced.
export async function lockForAuditKey(tx: TransactionClient, key: string): Promise<void> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', key);
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
export class MissingAuditActorError extends Error {
  readonly code = 'AUDIT_ACTOR_REQUIRED';
  readonly statusCode = 500;
  constructor(entityType: string) {
    super(`Refusing an admin change to ${entityType} with no authenticated actor to record`);
    this.name = 'MissingAuditActorError';
  }
}

export async function recordAdminAction(db: AuditWriter, entry: AdminAuditEntry): Promise<void> {
  // Fail closed. Every admin route authenticates first, so an absent actor means a code
  // path lost it — and since callers write inside the change's transaction, throwing here
  // rolls the change back instead of committing it unattributed.
  if (!entry.actorId) throw new MissingAuditActorError(entry.entityType);
  const metadata = {
    ...(jsonSafe(entry.before) !== undefined ? { before: jsonSafe(entry.before) } : {}),
    ...(jsonSafe(entry.after) !== undefined ? { after: jsonSafe(entry.after) } : {}),
    ...(entry.result ? { result: entry.result } : {}),
    ...(entry.notes ? { notes: entry.notes } : {}),
  };

  await db.adminActivityLog.create({
    data: {
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
      action: entry.action,
      entityType: entry.entityType,
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.ipAddress ? { ipAddress: entry.ipAddress } : {}),
      ...(entry.userAgent ? { userAgent: entry.userAgent } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  });
}

/// For an admin action whose effect lives outside PostgreSQL — a BullMQ job, a Redis
/// key — so no transaction can tie the audit row to the change.
///
/// REQUESTED is written before acting: if it cannot be written, nothing is done, so an
/// action is never taken unlogged. The outcome row follows: SUCCESS, or FAILED with the
/// error's message. A crash between the act and the outcome leaves REQUESTED alone,
/// which reads as "outcome unknown" — never as a success that did not happen.
///
/// `classify` is for an act that reports its outcome in its return value rather than by
/// throwing — a provider that rejected a test send (FAILED), a claim someone else already
/// made (NO_OP). It names the outcome and the safe `after` to record; without it,
/// returning means SUCCESS.
///
/// A FAILED row stores a stable error code and a redacted reason, never the raw message:
/// provider errors echo recipients, codes and tokens.
export type ExternalOutcome = 'SUCCESS' | 'FAILED' | 'NO_OP';

export async function auditExternalAction<T>(
  db: AuditWriter,
  entry: Omit<AdminAuditEntry, 'result'>,
  act: () => Promise<T>,
  classify?: (value: T) => { outcome: ExternalOutcome; after?: unknown },
): Promise<T> {
  await recordAdminAction(db, { ...entry, result: 'REQUESTED' });
  let value: T;
  try {
    value = await act();
  } catch (err) {
    await recordAdminAction(db, { ...entry, after: safeErrorSummary(err), result: 'FAILED' }).catch(
      () => {
        // The REQUESTED row already stands without an outcome; the caller's error wins.
      },
    );
    throw err;
  }
  const outcome = classify?.(value);
  await recordAdminAction(db, {
    ...entry,
    ...(outcome?.after !== undefined ? { after: outcome.after } : {}),
    result: outcome?.outcome ?? 'SUCCESS',
  });
  return value;
}
