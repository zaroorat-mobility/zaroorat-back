/// One-off backfill for drivers sent back for corrections before the resubmission state
/// changed (2026-10-13).
///
/// A resubmission request used to leave the driver REJECTED, the status a final rejection
/// also uses; it now leaves them PENDING with the instructions, so their next upload returns
/// them to review. Drivers sent back before that change are still REJECTED, and an upload no
/// longer moves a REJECTED driver. This moves exactly those drivers to PENDING.
///
/// What counts as "sent back": the latest verification decision recorded for the driver in
/// `admin_activity_logs` is a resubmission request — `action UPDATE`,
/// `metadata.after.decision = 'RESUBMISSION_REQUESTED'` — written as it was from 2026-10-03
/// (`after.verificationStatus = 'REJECTED'`), and nothing has changed since: the driver is
/// still REJECTED with the very instructions that request recorded, and is neither blocked,
/// suspended nor deleted. Approvals (`APPROVE`) and final rejections (`REJECT`) are the other
/// decisions. Before 2026-10-03 no verification decision was audited at all, so a REJECTED
/// driver with no decision history cannot be told apart and goes to manual review.
///
/// A driver who uploaded while REJECTED was sent back too, but the upload never reached
/// review (an upload does not move a REJECTED driver): returning them to PENDING would ask
/// them to upload again, so they go to manual review instead.
///
/// Dry-run by default. Applying takes the reviewed dry run's fingerprint and refuses a plan
/// that has changed since; it re-checks every driver under its row lock in its own
/// transaction and changes only the status; the instructions are kept, no decision is
/// invented and no notification is sent. One audit row per driver records the correction,
/// attributed to an operator who must be an active admin or system admin.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Client as PgClient } from 'pg';
import { ConnectionError, PrismaErrorMapper, type ProviderClient } from '@core/database/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../../generated/prisma/index.js';
import { lockForAudit, recordAdminAction } from '../../audit/index.js';

/// Marks the audit row this backfill writes, and the backfill in reports.
export const RESUBMISSION_BACKFILL = 'RESUBMISSION_STATE_2026_10';
/// The note the pre-2026-10-03 code saved when an admin sent a driver back with no text.
const LEGACY_DEFAULT_INSTRUCTIONS = 'Resubmission requested';
/// The request's audit time and a document's `updatedAt` are stamped by different
/// processes' clocks, so an upload this close before the request may have followed it;
/// such a driver goes to review rather than being guessed about.
const UPLOAD_CLOCK_MARGIN_MS = 2 * 60_000;

/// A check that failed for safety or authorization. It stops the whole run and is never
/// reported as one driver's failure.
export class BackfillRefusal extends Error {
  constructor(why: string) {
    super(`Refusing to run: ${why}`);
    this.name = 'BackfillRefusal';
  }
}

type Client = Pick<
  ProviderClient,
  | 'driver'
  | 'adminActivityLog'
  | 'vehicleDocument'
  | 'user'
  | 'userRoleAssignment'
  | '$transaction'
  | '$queryRaw'
>;
type Reader = Pick<
  TransactionClient,
  'driver' | 'adminActivityLog' | 'vehicleDocument' | 'user' | 'userRoleAssignment'
>;

export interface PendingDocument {
  source: 'driver' | 'vehicle';
  documentType: string;
  updatedAt: Date;
}

export interface CandidateDriver {
  id: string;
  userId: string;
  driverCode: string;
  verificationStatus: string;
  rejectionReason: string | null;
  isSuspended: boolean;
  deletedAt: Date | null;
  userStatus: string;
  /// The driver's PENDING documents and those of their current vehicle
  /// (`drivers.current_vehicle_id`, the link approval reviews).
  pendingDocuments: PendingDocument[];
}

export interface DecisionRow {
  id: string;
  action: string;
  createdAt: Date;
  metadata: unknown;
}

type Decision = { row: DecisionRow; kind: 'APPROVE' | 'REJECT' | 'RESUBMISSION' };

export type ExclusionReason =
  'NOT_REJECTED' | 'DELETED' | 'BLOCKED' | 'SUSPENDED' | 'FINAL_REJECTION';
export type ReviewReason =
  | 'NO_DECISION_AUDIT'
  | 'TIED_LATEST_DECISIONS'
  | 'STATUS_CONTRADICTS_LATEST_DECISION'
  | 'RESUBMISSION_RECORDED_WITH_OTHER_STATUS'
  | 'INSTRUCTIONS_CHANGED_SINCE_REQUEST'
  | 'DOCUMENTS_UPLOADED_SINCE_REQUEST';

export type Classification =
  | { outcome: 'eligible'; sourceAuditId: string; requestedAt: Date; why: string }
  | { outcome: 'excluded'; reason: ExclusionReason; why: string }
  | { outcome: 'review'; reason: ReviewReason; why: string; legacyDefaultInstructions?: boolean };

function decisionOf(row: DecisionRow): Decision | null {
  const meta = (row.metadata ?? {}) as { result?: unknown; after?: { decision?: unknown } };
  if (meta.result !== undefined && meta.result !== 'SUCCESS') return null;
  if (row.action === 'APPROVE') return { row, kind: 'APPROVE' };
  if (row.action === 'REJECT') return { row, kind: 'REJECT' };
  if (row.action === 'UPDATE' && meta.after?.decision === 'RESUBMISSION_REQUESTED') {
    return { row, kind: 'RESUBMISSION' };
  }
  return null;
}

/// Decides one driver from its current row and its audit history (any order). Pure: the
/// dry run and the locked re-check inside `apply` use exactly the same rules.
export function classifyResubmissionCandidate(
  driver: CandidateDriver,
  history: DecisionRow[],
): Classification {
  if (driver.verificationStatus !== 'REJECTED') {
    return {
      outcome: 'excluded',
      reason: 'NOT_REJECTED',
      why: `status is ${driver.verificationStatus}`,
    };
  }
  if (driver.deletedAt) {
    return { outcome: 'excluded', reason: 'DELETED', why: 'driver is soft-deleted' };
  }
  if (driver.userStatus === 'DEACTIVATED') {
    return { outcome: 'excluded', reason: 'BLOCKED', why: 'account is blocked (DEACTIVATED)' };
  }
  if (driver.isSuspended || driver.userStatus === 'SUSPENDED') {
    return { outcome: 'excluded', reason: 'SUSPENDED', why: 'driver or account is suspended' };
  }

  const decisions = history
    .map(decisionOf)
    .filter((d): d is Decision => d !== null)
    .sort(
      (a, b) =>
        a.row.createdAt.getTime() - b.row.createdAt.getTime() || a.row.id.localeCompare(b.row.id),
    );
  const latest = decisions.at(-1);
  if (!latest) {
    return {
      outcome: 'review',
      reason: 'NO_DECISION_AUDIT',
      why: 'REJECTED with no audited decision; decisions before 2026-10-03 were not audited',
      legacyDefaultInstructions: driver.rejectionReason === LEGACY_DEFAULT_INSTRUCTIONS,
    };
  }
  const tied = decisions.filter(
    (d) => d.row.createdAt.getTime() === latest.row.createdAt.getTime() && d.kind !== latest.kind,
  );
  if (tied.length > 0) {
    return {
      outcome: 'review',
      reason: 'TIED_LATEST_DECISIONS',
      why: `different decisions recorded at the same instant (${latest.row.createdAt.toISOString()})`,
    };
  }
  if (latest.kind === 'REJECT') {
    return {
      outcome: 'excluded',
      reason: 'FINAL_REJECTION',
      why: `latest decision is a final rejection (audit ${latest.row.id})`,
    };
  }
  if (latest.kind === 'APPROVE') {
    return {
      outcome: 'review',
      reason: 'STATUS_CONTRADICTS_LATEST_DECISION',
      why: `REJECTED, but the latest decision is an approval (audit ${latest.row.id})`,
    };
  }

  const after = ((latest.row.metadata ?? {}) as { after?: Record<string, unknown> }).after ?? {};
  if (after.verificationStatus !== 'REJECTED') {
    return {
      outcome: 'review',
      reason: 'RESUBMISSION_RECORDED_WITH_OTHER_STATUS',
      why: `the request recorded status ${String(after.verificationStatus)}, yet the driver is REJECTED`,
    };
  }
  if (after.rejectionReason !== driver.rejectionReason) {
    return {
      outcome: 'review',
      reason: 'INSTRUCTIONS_CHANGED_SINCE_REQUEST',
      why: 'the current instructions differ from the ones the request recorded',
    };
  }
  const since = latest.row.createdAt.getTime() - UPLOAD_CLOCK_MARGIN_MS;
  const uploaded = driver.pendingDocuments.filter((d) => d.updatedAt.getTime() > since);
  if (uploaded.length > 0) {
    const which = uploaded.map((d) => `${d.source} ${d.documentType}`).join(', ');
    return {
      outcome: 'review',
      reason: 'DOCUMENTS_UPLOADED_SINCE_REQUEST',
      why: `pending ${which} uploaded after the request in audit ${latest.row.id}; it never reached review, so the driver must not be asked to upload again`,
    };
  }
  return {
    outcome: 'eligible',
    sourceAuditId: latest.row.id,
    requestedAt: latest.row.createdAt,
    why: `latest decision is the resubmission request in audit ${latest.row.id}; still REJECTED with its instructions, not blocked or suspended`,
  };
}

async function readCandidates(db: Reader, ids?: string[]): Promise<CandidateDriver[]> {
  const pending = { verificationStatus: 'PENDING' as const };
  const rows = await db.driver.findMany({
    where: { verificationStatus: 'REJECTED', ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      userId: true,
      driverCode: true,
      verificationStatus: true,
      rejectionReason: true,
      isSuspended: true,
      deletedAt: true,
      currentVehicleId: true,
      user: { select: { status: true } },
      documents: { where: pending, select: { documentType: true, updatedAt: true } },
    },
    orderBy: { id: 'asc' },
  });
  const vehicleIds = rows.flatMap((row) => (row.currentVehicleId ? [row.currentVehicleId] : []));
  const vehicleDocuments = vehicleIds.length
    ? await db.vehicleDocument.findMany({
        where: { vehicleId: { in: vehicleIds }, ...pending },
        select: { vehicleId: true, documentType: true, updatedAt: true },
      })
    : [];
  return rows.map(({ user, documents, currentVehicleId, ...row }) => ({
    ...row,
    userStatus: user.status,
    pendingDocuments: [
      ...documents.map((d) => ({ source: 'driver' as const, ...d })),
      ...vehicleDocuments
        .filter((d) => d.vehicleId === currentVehicleId)
        .map(({ documentType, updatedAt }) => ({
          source: 'vehicle' as const,
          documentType,
          updatedAt,
        })),
    ],
  }));
}

async function readHistory(db: Reader, ids: string[]): Promise<Map<string, DecisionRow[]>> {
  const rows = await db.adminActivityLog.findMany({
    where: {
      entityType: 'driver',
      entityId: { in: ids },
      OR: [
        { action: { in: ['APPROVE', 'REJECT'] } },
        {
          action: 'UPDATE',
          metadata: { path: ['after', 'decision'], equals: 'RESUBMISSION_REQUESTED' },
        },
      ],
    },
    select: { id: true, entityId: true, action: true, createdAt: true, metadata: true },
  });
  const byDriver = new Map<string, DecisionRow[]>();
  for (const { entityId, ...row } of rows) {
    if (!entityId) continue;
    byDriver.set(entityId, [...(byDriver.get(entityId) ?? []), row]);
  }
  return byDriver;
}

export interface PlannedDriver {
  driverId: string;
  driverCode: string;
  sourceAuditId: string;
  requestedAt: string;
  why: string;
}

export interface BackfillPlan {
  backfill: typeof RESUBMISSION_BACKFILL;
  /// Identifies exactly which drivers would change and on which source requests; applying
  /// requires it (`--plan`), so only the reviewed set can be applied.
  fingerprint: string;
  scannedRejected: number;
  eligible: PlannedDriver[];
  excluded: Array<{ driverId: string; driverCode: string; reason: ExclusionReason; why: string }>;
  manualReview: Array<{
    driverId: string;
    driverCode: string;
    reason: ReviewReason;
    why: string;
    legacyDefaultInstructions?: boolean;
  }>;
}

/// SHA-256 over the eligible (driver, source request) pairs, order-independent. A count would
/// not do: one driver dropping out while another joins keeps it, and so does a driver now
/// resting on a different request.
export function planFingerprint(
  eligible: Array<{ driverId: string; sourceAuditId: string }>,
): string {
  const lines = eligible.map((e) => `${e.driverId}:${e.sourceAuditId}`).sort();
  return createHash('sha256')
    .update([RESUBMISSION_BACKFILL, ...lines].join('\n'))
    .digest('hex');
}

/// Reads only. Identifies drivers by id and driver code; never phone numbers, names, the
/// instructions themselves or document data.
export async function planResubmissionBackfill(db: Client): Promise<BackfillPlan> {
  const drivers = await readCandidates(db);
  const history = await readHistory(
    db,
    drivers.map((d) => d.id),
  );
  const plan: BackfillPlan = {
    backfill: RESUBMISSION_BACKFILL,
    fingerprint: '',
    scannedRejected: drivers.length,
    eligible: [],
    excluded: [],
    manualReview: [],
  };
  for (const driver of drivers) {
    const result = classifyResubmissionCandidate(driver, history.get(driver.id) ?? []);
    const who = { driverId: driver.id, driverCode: driver.driverCode };
    if (result.outcome === 'eligible') {
      plan.eligible.push({
        ...who,
        sourceAuditId: result.sourceAuditId,
        requestedAt: result.requestedAt.toISOString(),
        why: result.why,
      });
    } else if (result.outcome === 'excluded') {
      plan.excluded.push({ ...who, reason: result.reason, why: result.why });
    } else {
      plan.manualReview.push({
        ...who,
        reason: result.reason,
        why: result.why,
        ...(result.legacyDefaultInstructions ? { legacyDefaultInstructions: true } : {}),
      });
    }
  }
  plan.fingerprint = planFingerprint(plan.eligible);
  return plan;
}

export interface ApplyReport {
  /// The plan this run applied: the reviewed fingerprint, re-verified at the start.
  fingerprint: string;
  eligible: number;
  updated: Array<{ driverId: string; driverCode: string; sourceAuditId: string }>;
  skipped: Array<{ driverId: string; driverCode: string; why: string }>;
  failed: Array<{ driverId: string; driverCode: string; error: string }>;
}

export interface ApplyOptions {
  /// How long one driver's transaction waits for a row another session holds before that
  /// driver is recorded as failed. Integer milliseconds.
  lockTimeoutMs?: number;
}

/// The run stopped part-way: a refusal, a bug or a lost database. `report` holds what had
/// been done; every driver it lists as updated is committed, the rest untouched.
export class BackfillAborted extends Error {
  constructor(
    public readonly report: ApplyReport,
    cause: unknown,
  ) {
    const done = report.updated.length + report.skipped.length + report.failed.length;
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`Stopped after ${done} of ${report.eligible} drivers: ${why}`, { cause });
    this.name = 'BackfillAborted';
  }
}

/// 0: nothing failed. 2: some drivers failed, the rest were applied. 3: every driver failed.
/// (1 is a run that was refused or stopped.)
export function exitCodeFor(report: ApplyReport): number {
  if (report.failed.length === 0) return 0;
  return report.updated.length + report.skipped.length > 0 ? 2 : 3;
}

/// A database failure confined to one driver's transaction — a lock not granted in time, a
/// write conflict, a constraint, a transaction that expired — which rolled back that driver
/// alone. Returned as the reason to record. Anything else stops the run: a refusal, a bug
/// (including a malformed query), and a lost database, which every next driver would hit.
function driverFailure(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (PrismaErrorMapper.mapError(err) instanceof ConnectionError) return null;
  const meta = err.meta as
    | { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const detail = cause?.originalMessage ?? err.message.trim().split('\n').at(-1);
  return `${err.code}${cause?.originalCode ? ` (${cause.originalCode})` : ''}: ${detail}`;
}

/// Applies the reviewed plan, one driver per transaction. The plan is first computed afresh
/// and must carry the fingerprint the operator reviewed: a driver added or dropped, or bound
/// to another source request, stops the run before any change. Then each driver is locked,
/// re-read and re-classified: only a driver still eligible on the same source request is
/// changed, and the update is conditional on the status and instructions read under the lock.
/// Anything that moved since is skipped and reported, never forced.
///
/// The operator is re-checked in every transaction, so a revoked or deactivated admin stops
/// the run at the next driver; an operator who is one of the drivers stops it before any
/// change. Uploads take the driver row lock first, and the current vehicle's document rows
/// are share-locked, so no upload lands between the re-check and the update.
///
/// One driver's database failure rolls back that driver only and is recorded; the run goes
/// on. A refusal, a bug or a lost database stops it with BackfillAborted. Rerunning is safe:
/// corrected drivers are no longer REJECTED, so a fresh dry run lists only the rest.
export async function applyResubmissionBackfill(
  db: Client,
  reviewed: { fingerprint: string },
  operator: { actorId: string },
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new BackfillRefusal('lockTimeoutMs must be a positive integer.');
  }
  await assertAuthorizedActor(db, operator.actorId);
  const plan = await planResubmissionBackfill(db);
  if (plan.fingerprint !== reviewed.fingerprint) {
    throw new BackfillRefusal(
      `the plan changed since the reviewed dry run (now ${plan.eligible.length} eligible, plan ${plan.fingerprint}); run the dry run again and review it.`,
    );
  }
  const ownApplication = await db.driver.count({
    where: { id: { in: plan.eligible.map((p) => p.driverId) }, userId: operator.actorId },
  });
  if (ownApplication > 0) throw selfTargeted(operator.actorId);

  const report: ApplyReport = {
    fingerprint: plan.fingerprint,
    eligible: plan.eligible.length,
    updated: [],
    skipped: [],
    failed: [],
  };
  for (const planned of plan.eligible) {
    const who = { driverId: planned.driverId, driverCode: planned.driverCode };
    try {
      const skipped = await correctOne(db, planned, operator.actorId, lockTimeoutMs);
      if (skipped) report.skipped.push({ ...who, why: skipped });
      else report.updated.push({ ...who, sourceAuditId: planned.sourceAuditId });
    } catch (err) {
      const failure = driverFailure(err);
      if (failure === null) throw new BackfillAborted(report, err);
      report.failed.push({ ...who, error: failure });
    }
  }
  return report;
}

/// One driver, in its own transaction. Returns why it was skipped, or null once corrected.
function correctOne(
  db: Client,
  planned: PlannedDriver,
  actorId: string,
  lockTimeoutMs: number,
): Promise<string | null> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
      await assertAuthorizedActor(tx, actorId);
      await lockForAudit(tx, 'drivers', planned.driverId);
      const link = await tx.driver.findUnique({
        where: { id: planned.driverId },
        select: { currentVehicleId: true },
      });
      if (link?.currentVehicleId) {
        await tx.$queryRaw`
          SELECT 1 FROM vehicle_documents WHERE vehicle_id = ${link.currentVehicleId}::uuid FOR SHARE`;
      }
      const [driver] = await readCandidates(tx, [planned.driverId]);
      if (!driver) return 'no longer REJECTED';
      if (driver.userId === actorId) throw selfTargeted(actorId);
      const history = await readHistory(tx, [driver.id]);
      const now = classifyResubmissionCandidate(driver, history.get(driver.id) ?? []);
      if (now.outcome !== 'eligible') return `no longer eligible: ${now.why}`;
      if (now.sourceAuditId !== planned.sourceAuditId) {
        return `a newer resubmission request (${now.sourceAuditId}) superseded the plan`;
      }
      const { count } = await tx.driver.updateMany({
        where: {
          id: driver.id,
          verificationStatus: 'REJECTED',
          rejectionReason: driver.rejectionReason,
        },
        data: { verificationStatus: 'PENDING' },
      });
      if (count !== 1) return 'changed during the update';
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: driver.id,
        summary: 'Driver status backfilled: resubmission request now PENDING',
        notes: `Data correction for the resubmission request in audit ${planned.sourceAuditId}; instructions unchanged`,
        before: { verificationStatus: 'REJECTED' },
        after: {
          verificationStatus: 'PENDING',
          backfill: RESUBMISSION_BACKFILL,
          sourceAuditId: planned.sourceAuditId,
        },
        result: 'SUCCESS',
      });
      return null;
    },
    // Longer than any lock wait, so a held row fails on lock_timeout rather than on expiry.
    { timeout: lockTimeoutMs * 2 + 10_000 },
  );
}

// ── The operator ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const selfTargeted = (actorId: string) =>
  new BackfillRefusal(
    `the operator ${actorId} is one of the drivers to change; nobody corrects their own application.`,
  );

/// The operator must be someone the admin API would let decide a driver's verification: an
/// ACTIVE, undeleted account holding, through an unrevoked and unexpired role assignment,
/// `system_admin`, or `admin` together with `drivers:verify` (what the decision routes
/// require). The same assignment rules as `authorize()` and PermissionRepository.
export async function assertAuthorizedActor(
  db: Pick<Reader, 'user' | 'userRoleAssignment'>,
  actorId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!UUID.test(actorId)) throw new BackfillRefusal('--actor must be a user id.');
  const user = await db.user.findUnique({
    where: { id: actorId },
    select: { status: true, deletedAt: true },
  });
  if (!user) throw new BackfillRefusal(`no user ${actorId} to attribute the change to.`);
  if (user.deletedAt) throw new BackfillRefusal(`the operator ${actorId} is deleted.`);
  if (user.status !== 'ACTIVE') {
    throw new BackfillRefusal(`the operator ${actorId} is ${user.status}, not ACTIVE.`);
  }
  const held = await db.userRoleAssignment.findMany({
    where: {
      userId: actorId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: {
      role: {
        select: {
          slug: true,
          permissions: {
            where: { effect: 'ALLOW', permission: { code: 'drivers:verify' } },
            select: { id: true },
          },
        },
      },
    },
  });
  const slugs = held.map((assignment) => assignment.role.slug);
  const canVerify = held.some((assignment) => assignment.role.permissions.length > 0);
  if (slugs.includes('system_admin')) return;
  if (slugs.includes('admin') && canVerify) return;
  throw new BackfillRefusal(
    slugs.includes('admin')
      ? `the operator ${actorId} is an admin without drivers:verify.`
      : `the operator ${actorId} is not an active admin or system admin.`,
  );
}

// ── Command-line guards ─────────────────────────────────────────────────────────

export interface Endpoint {
  host: string;
  port: number;
}

export interface BackfillCliOptions {
  apply: boolean;
  env: string | undefined;
  database: string | undefined;
  host: Endpoint | undefined;
  actor: string | undefined;
  /// The fingerprint of the reviewed dry run, required to apply.
  plan: string | undefined;
  allowProduction: boolean;
}

const VALUE_FLAGS = ['--env', '--database', '--host', '--actor', '--plan'];
const SWITCHES = ['--apply', '--allow-production'];
const DEFAULT_PORT = 5432;

const formatEndpoint = ({ host, port }: Endpoint) =>
  `${host.includes(':') ? `[${host}]` : host}:${port}`;

/// `host`, `host:port` or `[ipv6]:port`; an omitted port means Postgres' 5432.
function parseHost(raw: string): Endpoint {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::(\d{1,5}))?$/i.exec(raw);
  const port = match?.[3] === undefined ? DEFAULT_PORT : Number(match[3]);
  if (!match || port < 1 || port > 65535) {
    throw new BackfillRefusal('--host must be <host> or <host>:<port> (IPv6 as [addr]:port).');
  }
  return { host: (match[1] ?? match[2] ?? '').toLowerCase(), port };
}

/// Strict: an unknown, repeated or valueless argument stops the run, so a typo can never
/// quietly drop a guard. A stray value is not echoed — it might be a pasted secret.
export function parseBackfillArgs(argv: string[]): BackfillCliOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (values.has(arg) || switches.has(arg)) {
      throw new BackfillRefusal(`${arg} is given more than once.`);
    }
    if (SWITCHES.includes(arg)) {
      switches.add(arg);
    } else if (VALUE_FLAGS.includes(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BackfillRefusal(`${arg} needs a value.`);
      }
      values.set(arg, next);
      i += 1;
    } else {
      throw new BackfillRefusal(
        arg.startsWith('--')
          ? `unknown argument ${arg}.`
          : `unexpected value at argument ${i + 1}.`,
      );
    }
  }
  const host = values.get('--host');
  return {
    apply: switches.has('--apply'),
    env: values.get('--env'),
    database: values.get('--database'),
    host: host === undefined ? undefined : parseHost(host),
    actor: values.get('--actor'),
    plan: values.get('--plan'),
    allowProduction: switches.has('--allow-production'),
  };
}

/// Where the pool's connections actually go, resolved by pg itself from the connection
/// string: a `host` or `port` in the query string overrides the URL's authority, and
/// PGHOST/PGPORT fill what it leaves out. Only host and port leave this function; the
/// URL, user and password never do, not even in an error.
export function databaseEndpoint(url: string): Endpoint {
  let resolved: Endpoint;
  try {
    const client = new PgClient({ connectionString: url });
    resolved = { host: client.host, port: client.port };
  } catch {
    throw new BackfillRefusal('the database URL could not be parsed.');
  }
  const host = resolved.host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host || host.startsWith('/') || !Number.isInteger(resolved.port)) {
    throw new BackfillRefusal('the database must be reached over TCP at a named host.');
  }
  return { host, port: resolved.port };
}

const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

export interface ConnectedTarget extends Endpoint {
  /// APP_ENV as loaded.
  environment: string;
  /// `current_database()`, from the server itself.
  database: string;
}

export interface VerifiedTarget {
  environment: string;
  database: string;
  /// host:port — no user, password or URL.
  host: string;
}

/// The operator names the environment, the database and the server they mean; each must
/// match what this process is actually connected to, so a DATABASE_URL left in the shell
/// cannot point the run elsewhere unnoticed — not even at a production database that shares
/// the development database's name.
///
/// APP_ENV alone never establishes that a target is not production. Development and test
/// must be on this machine (loopback); a remote server under those names is refused
/// outright. Production, and every non-loopback server whatever APP_ENV says, runs only
/// with --allow-production. An SSH tunnel to production on a loopback port cannot be told
/// apart by address, which is why --env, --database and --host must all be typed.
export function assertSafeTarget(
  options: BackfillCliOptions,
  connected: ConnectedTarget,
): VerifiedTarget {
  if (!options.env) throw new BackfillRefusal('pass --env <environment> to confirm the target.');
  if (!options.database) {
    throw new BackfillRefusal('pass --database <name> to confirm the target database.');
  }
  if (!options.host) {
    throw new BackfillRefusal('pass --host <host[:port]> to confirm the database server.');
  }
  if (options.env !== connected.environment) {
    throw new BackfillRefusal(
      `--env ${options.env} does not match the loaded environment ${connected.environment}.`,
    );
  }
  if (options.database !== connected.database) {
    throw new BackfillRefusal(
      `--database ${options.database} does not match the connected database ${connected.database}.`,
    );
  }
  const server = formatEndpoint(connected);
  if (options.host.host !== connected.host || options.host.port !== connected.port) {
    throw new BackfillRefusal(
      `--host ${formatEndpoint(options.host)} does not match the connected server ${server}.`,
    );
  }
  const loopback = isLoopback(connected.host);
  if (!loopback && (connected.environment === 'development' || connected.environment === 'test')) {
    throw new BackfillRefusal(
      `APP_ENV=${connected.environment} but the database server ${server} is not on this machine.`,
    );
  }
  if ((connected.environment === 'production' || !loopback) && !options.allowProduction) {
    throw new BackfillRefusal(
      `${server} is treated as production (${connected.environment === 'production' ? 'APP_ENV=production' : 'a remote server'}); pass --allow-production once the dry run is reviewed.`,
    );
  }
  if (options.apply && !options.actor) {
    throw new BackfillRefusal('pass --actor <admin user id> to attribute the change.');
  }
  if (options.apply && !/^[0-9a-f]{64}$/.test(options.plan ?? '')) {
    throw new BackfillRefusal('pass --plan <fingerprint> from the reviewed dry run.');
  }
  return { environment: connected.environment, database: connected.database, host: server };
}
