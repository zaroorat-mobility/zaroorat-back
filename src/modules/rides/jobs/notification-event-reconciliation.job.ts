import { RedisService } from '@core/cache/RedisService.js';
import { RedisKeys } from '@core/cache/keys.js';
import { ConnectionError, DatabaseService, PrismaErrorMapper } from '@core/database';
import { RetryService } from '@core/database/retry/RetryService.js';
import type { EventEnvelope } from '@core/events';
import type { OutboxRepository, PublishedOutboxEvent } from '@core/events/OutboxRepository.js';
import type { NotificationRepository } from '@modules/notifications/repositories/notification.repository.js';
import {
  notificationEventReconciliationCount,
  notificationEventReconciliationGauge,
} from '@modules/notifications/metrics/notification.metrics.js';
import {
  resolveDeliveryPresentation,
  resolveNotificationPriority,
  resolveOfferWindow,
} from '@modules/notifications/policies/notification-priority.policy.js';
import { logger } from '@shared/logger/index.js';
import { isUuid } from '@shared/validation/index.js';
import { EnqueueTimeoutError } from '../../../jobs/queues/index.js';
import {
  NOTIFICATION_EVENT_TYPES,
  planNotifications,
  type NotificationLookups,
  type PlanOutcome,
} from '../consumers/ride-notification.planner.js';
import { writeNotificationPlan, type WriteOutcome } from '../consumers/ride-notification.writer.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';

/// F3 — recovers ride notifications whose event was published but whose
/// notification row was never written: the consumer's lookup or insert failed,
/// it swallowed the failure (as it must), and the relay marked the event
/// PUBLISHED. PA-11 cannot help there — it only re-enqueues rows that exist.
///
/// It replays nothing on the event bus. It reads the durable outbox, plans each
/// event with the same planner as the live consumer, and writes what is missing
/// with the same writer. The unique `notifications.idempotency_key` is the
/// correctness boundary: whatever races with it — the consumer, another run —
/// one row per key survives, and only its writer enqueues. A row it writes but
/// cannot enqueue is PA-11's, like any other.

/// Offers are not reconciled: their window (RIDE_DISPATCH_TIMEOUT_SEC, 10s) is
/// always closed by the time an event clears the grace period, and dispatch
/// re-offers anyway. `eventExpiry` still judges them correctly if that changes.
export const RECONCILED_EVENT_TYPES: readonly string[] = NOTIFICATION_EVENT_TYPES.filter(
  (type) => type !== RIDE_EVENT_CATALOG.DISPATCH_OFFERED,
);

/// How long after publication an event becomes a candidate. `published_at` is
/// written by the relay's clock; a row whose commit lands later than this after
/// its timestamp — clock skew plus commit latency — could be passed by the
/// cursor. A minute is far beyond either.
export const RECONCILE_EVENT_GRACE_MS = 60_000;

export const RECONCILE_EVENT_PAGE_SIZE = 200;

/// A run stops taking new pages after this; the next tick continues.
export const RECONCILE_EVENT_RUN_BUDGET_MS = 40_000;

/// Outlives a run (budget + one page), so runs never overlap; if one ever did,
/// the idempotency key would still decide.
export const RECONCILE_EVENT_LOCK_TTL_MS = 90_000;

/// Nothing older than the longest delivery TTL of a reconciled type can be
/// recovered (1 hour: every reconciled type is TRANSACTIONAL), so the scan never
/// reaches further back, whatever the cursor says.
export const RECONCILE_EVENT_LOOKBACK_MS = Math.max(
  ...RECONCILED_EVENT_TYPES.map(
    (type) => resolveDeliveryPresentation(resolveNotificationPriority(type).deliveryClass).ttlMs,
  ),
);

const LOCK = 'job:notification_event_reconciliation';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const retry = new RetryService();

export type ReconciliationMode = 'off' | 'dry-run' | 'on';

export interface ReconciliationCursor {
  publishedAt: Date;
  id: string;
}

export interface NotificationEventReconciliationReport {
  ran: boolean;
  mode: ReconciliationMode;
  /// Outbox events read.
  scanned: number;
  /// Readable and still within their TTL.
  eligible: number;
  expired: number;
  /// Planner skips (no ride, `willRetry`, …) — exactly what the consumer skips.
  skipped: number;
  /// Notifications that already existed.
  present: number;
  /// Rows written by this run (including any whose enqueue then failed).
  recovered: number;
  /// Dry run: rows this run would have written.
  wouldRecover: number;
  /// Lost the insert race to a concurrent writer.
  duplicate: number;
  /// Written but not enqueued: left QUEUED for PA-11.
  enqueueFailed: number;
  permanentFailures: number;
  transientFailures: number;
  aborted: null | 'lock_held' | 'transient_db' | 'queue_unavailable' | 'budget';
  /// The scan reached the grace boundary.
  caughtUp: boolean;
  cursor: { publishedAt: string; id: string } | null;
  durationMs: number;
  /// Seconds since publication of the oldest eligible event left unreconciled;
  /// 0 once the scan reaches the grace boundary.
  lagSeconds: number;
}

/// Where the job's metrics go: the notification metrics in production; a test
/// may substitute its own, as PA-11's sweep takes a substitute queue.
export interface ReconciliationMetrics {
  count: typeof notificationEventReconciliationCount;
  gauge: typeof notificationEventReconciliationGauge;
}

const METRICS: ReconciliationMetrics = {
  count: notificationEventReconciliationCount,
  gauge: notificationEventReconciliationGauge,
};

/// Metrics are best effort: an emitter that throws costs the metric, never the
/// run's progress.
function guarded(metrics: ReconciliationMetrics): ReconciliationMetrics {
  return {
    count: (...args) => {
      try {
        metrics.count(...args);
      } catch {
        // Observability must not change what reconciliation does.
      }
    },
    gauge: (...args) => {
      try {
        metrics.gauge(...args);
      } catch {
        // Observability must not change what reconciliation does.
      }
    },
  };
}

/// Everything one run threads through its pages.
interface RunContext {
  now: Date;
  mode: ReconciliationMode;
  report: NotificationEventReconciliationReport;
  metrics: ReconciliationMetrics;
  recoveredAgeMaxSeconds: number;
}

/// `NOTIFICATION_EVENT_RECONCILIATION_MODE`: `on` writes, `dry-run` (the
/// default) only counts what it would write, `off` does nothing. Anything else
/// is treated as `off`.
export function resolveReconciliationMode(raw: string | undefined): ReconciliationMode {
  if (raw === undefined || raw === '') return 'dry-run';
  return raw === 'on' || raw === 'off' || raw === 'dry-run' ? raw : 'off';
}

/// The existing TTL rules, anchored on when the event was created. An offer is
/// judged by its own window (`resolveOfferWindow`: 0ms left is expired);
/// anything else by its class's delivery TTL, expired at exactly the TTL.
export function eventExpiry(
  eventType: string,
  data: Record<string, unknown>,
  createdAt: Date,
  now: Date,
): 'offer_expired' | 'ttl_elapsed' | null {
  const { deliveryClass } = resolveNotificationPriority(eventType);
  if (deliveryClass === 'RIDE_OFFER') {
    const window = resolveOfferWindow(data.expiresAt, now.getTime());
    if (window?.expired) return 'offer_expired';
    if (window) return null;
  }
  const { ttlMs } = resolveDeliveryPresentation(deliveryClass);
  return now.getTime() - createdAt.getTime() >= ttlMs ? 'ttl_elapsed' : null;
}

/// The envelope exactly as the relay handed it to the consumer — the outbox
/// payload — or null if the row is not one (mismatched ids, no `data`). A
/// payload without `data` is refused here, not normalised.
export function parseEnvelope(row: PublishedOutboxEvent): EventEnvelope | null {
  const payload = row.payload as Partial<EventEnvelope> | null;
  if (payload === null || typeof payload !== 'object') return null;
  if (payload.eventId !== row.eventId || payload.type !== row.eventType) return null;
  if (payload.data === null || typeof payload.data !== 'object') return null;
  return payload as EventEnvelope;
}

/// Retry what may succeed later; record and move past what never will.
/// Classified through the existing `PrismaErrorMapper` and `RetryService`.
export function classifyFailure(err: unknown): {
  result: 'transient' | 'permanent';
  reason: string;
} {
  const mapped = PrismaErrorMapper.isPrismaError(err) ? PrismaErrorMapper.mapError(err) : err;
  const code = prismaCode(err);
  if (retry.isTransientError(mapped)) {
    return {
      result: 'transient',
      reason:
        mapped instanceof ConnectionError
          ? 'connection'
          : code === 'P2034'
            ? 'write_conflict'
            : 'transient',
    };
  }
  if (!PrismaErrorMapper.isPrismaError(err)) return { result: 'permanent', reason: 'programming' };
  switch (code) {
    case 'P2000':
      return { result: 'permanent', reason: 'value_too_long' };
    case 'P2002':
      return { result: 'permanent', reason: 'unique_violation' };
    case 'P2003':
      return { result: 'permanent', reason: 'foreign_key' };
    case 'P2004':
      return { result: 'permanent', reason: 'constraint' };
    case 'P2007':
    case 'P2023':
      return { result: 'permanent', reason: 'invalid_data' };
    default:
      return {
        result: 'permanent',
        reason: (err as Error).name === 'PrismaClientValidationError' ? 'validation' : 'database',
      };
  }
}

export function parseCursor(raw: string | null): ReconciliationCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { publishedAt?: unknown; id?: unknown };
    if (typeof value.publishedAt !== 'string' || typeof value.id !== 'string') return null;
    const publishedAt = new Date(value.publishedAt);
    if (Number.isNaN(publishedAt.getTime()) || !isUuid(value.id)) return null;
    return { publishedAt, id: value.id };
  } catch {
    return null;
  }
}

/// Where a run starts: the stored cursor, unless it is missing or older than the
/// lookback floor — then the floor, inclusive.
export function resolveStart(
  stored: ReconciliationCursor | null,
  floor: Date,
): ReconciliationCursor {
  return stored && stored.publishedAt.getTime() >= floor.getTime()
    ? stored
    : { publishedAt: floor, id: NIL_UUID };
}

/// A lookup id that is not a UUID. The consumer's database read throws on one;
/// so does this, and the planner reports it as a failed lookup.
class InvalidReferenceError extends Error {
  constructor(kind: string) {
    super(`${kind} id is not a UUID`);
    this.name = 'InvalidReferenceError';
  }
}

type EventPlan =
  { kind: 'nothing' } | { kind: 'planned'; envelope: EventEnvelope; outcomes: PlanOutcome[] };

export class NotificationEventReconciliationJob {
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly notificationRepository: NotificationRepository,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async run(
    now: Date = new Date(),
    options: {
      mode?: ReconciliationMode;
      pageSize?: number;
      runBudgetMs?: number;
      metrics?: ReconciliationMetrics;
    } = {},
  ): Promise<NotificationEventReconciliationReport> {
    const mode =
      options.mode ?? resolveReconciliationMode(process.env.NOTIFICATION_EVENT_RECONCILIATION_MODE);
    const metrics = guarded(options.metrics ?? METRICS);
    const report: NotificationEventReconciliationReport = {
      ran: false,
      mode,
      scanned: 0,
      eligible: 0,
      expired: 0,
      skipped: 0,
      present: 0,
      recovered: 0,
      wouldRecover: 0,
      duplicate: 0,
      enqueueFailed: 0,
      permanentFailures: 0,
      transientFailures: 0,
      aborted: null,
      caughtUp: false,
      cursor: null,
      durationMs: 0,
      lagSeconds: 0,
    };
    if (mode === 'off') {
      metrics.count('runs', { result: 'off', scope: mode });
      return report;
    }

    const token = await this.redis.lock.acquire(LOCK, RECONCILE_EVENT_LOCK_TTL_MS);
    if (!token) {
      report.aborted = 'lock_held';
      metrics.count('runs', { result: 'lock_held', scope: mode });
      return report;
    }
    report.ran = true;
    const started = Date.now();
    const pageSize = options.pageSize ?? RECONCILE_EVENT_PAGE_SIZE;
    const deadline = started + (options.runBudgetMs ?? RECONCILE_EVENT_RUN_BUDGET_MS);
    const cursorKey = RedisKeys.notificationEventReconciliationCursor(mode);
    const context: RunContext = { now, mode, report, metrics, recoveredAgeMaxSeconds: 0 };
    const before = new Date(now.getTime() - RECONCILE_EVENT_GRACE_MS);
    // Publication time of the oldest eligible event this run left unreconciled.
    let leftBehind: Date | null = null;

    try {
      const floor = new Date(now.getTime() - RECONCILE_EVENT_LOOKBACK_MS);
      const stored = parseCursor(await this.redis.provider.client.get(cursorKey));
      if (!stored) {
        metrics.count('cursor_reset', { reason: 'missing' });
      } else if (stored.publishedAt.getTime() < floor.getTime()) {
        // Everything between the stored cursor and the floor is past its TTL and
        // will never be looked at: count it, it is what falling behind cost.
        metrics.count('cursor_reset', { reason: 'behind_lookback' });
        const passedOver = await this.observe(() =>
          this.outboxRepository.countPublished({
            from: stored.publishedAt,
            before: floor,
            eventTypes: RECONCILED_EVENT_TYPES,
          }),
        );
        if (passedOver !== null) metrics.count('window_skipped', undefined, passedOver);
      }
      let cursor = resolveStart(stored, floor);

      for (;;) {
        const pageStarted = Date.now();
        const page = await this.outboxRepository.findPublishedPage({
          after: cursor,
          before,
          eventTypes: RECONCILED_EVENT_TYPES,
          limit: pageSize,
        });
        if (page.length === 0) {
          report.caughtUp = true;
          break;
        }

        const { handledUpTo, aborted, stoppedAt } = await this.reconcilePage(page, context);
        metrics.count('pages', { scope: mode });
        metrics.count('page_duration_ms_total', { scope: mode }, Date.now() - pageStarted);
        if (handledUpTo) {
          cursor = handledUpTo;
          await this.redis.provider.client.set(
            cursorKey,
            JSON.stringify({ publishedAt: cursor.publishedAt.toISOString(), id: cursor.id }),
          );
          report.cursor = { publishedAt: cursor.publishedAt.toISOString(), id: cursor.id };
        }
        if (aborted) {
          report.aborted = aborted;
          leftBehind = stoppedAt;
          break;
        }
        if (page.length < pageSize) {
          report.caughtUp = true;
          break;
        }
        if (Date.now() >= deadline) {
          report.aborted = 'budget';
          // The next event is at or after the cursor, so this bounds its lag.
          leftBehind = cursor.publishedAt;
          break;
        }
      }
    } catch (err) {
      metrics.count('runs', { result: 'error', scope: mode });
      throw err;
    } finally {
      await this.redis.lock.release(LOCK, token);
    }

    report.durationMs = Date.now() - started;
    report.lagSeconds =
      report.caughtUp || !leftBehind
        ? 0
        : Math.max(0, (now.getTime() - leftBehind.getTime()) / 1000);
    metrics.count('runs', { result: report.aborted ?? 'caught_up', scope: mode });
    metrics.count('run_duration_ms_total', { scope: mode }, report.durationMs);
    metrics.gauge('last_run_duration_ms', report.durationMs);
    metrics.gauge('lag_seconds', report.lagSeconds);
    metrics.gauge('recovered_age_seconds_max', context.recoveredAgeMaxSeconds);
    // With the database unreachable this read would only wait to fail too.
    if (report.aborted !== 'transient_db') {
      const inGrace = await this.observe(() =>
        this.outboxRepository.countPublished({ from: before, eventTypes: RECONCILED_EVENT_TYPES }),
      );
      if (inGrace !== null) metrics.gauge('in_grace', inGrace);
    }

    if (report.scanned > 0 || report.aborted) {
      logger.info({ report }, '[NotificationEventReconciliation] run finished');
    }
    return report;
  }

  /// One page, in order. Returns the last event fully handled — the cursor may
  /// advance to it — and why the run must stop, if it must. An event that hits
  /// a transient failure is not handled: the next run starts at it again.
  private async reconcilePage(
    page: PublishedOutboxEvent[],
    context: RunContext,
  ): Promise<{
    handledUpTo: ReconciliationCursor | null;
    aborted: 'transient_db' | 'queue_unavailable' | null;
    /// Publication time of the first event not handled, when aborted.
    stoppedAt: Date | null;
  }> {
    const { now, report, metrics } = context;
    // Decide what needs no database at all: unreadable and expired events.
    const candidates: Array<{ row: PublishedOutboxEvent; envelope: EventEnvelope }> = [];
    const planOf = new Map<string, EventPlan>();
    for (const row of page) {
      report.scanned += 1;
      metrics.count('scanned', { event_type: row.eventType });
      planOf.set(row.id, { kind: 'nothing' });
      const envelope = parseEnvelope(row);
      if (!envelope) {
        this.permanent(row, context, 'invalid_envelope');
        continue;
      }
      const expiry = eventExpiry(row.eventType, envelope.data, row.createdAt, now);
      if (expiry) {
        report.expired += 1;
        metrics.count('expired', { event_type: row.eventType, reason: expiry });
        continue;
      }
      report.eligible += 1;
      metrics.count('eligible', { event_type: row.eventType });
      candidates.push({ row, envelope });
    }

    // Plan every candidate against one batch of reads, then ask once which of
    // the planned notifications already exist. A failure here stops the run with
    // no progress on this page.
    let existing: Set<string>;
    try {
      const lookups = await this.preload(candidates.map((c) => c.envelope));
      for (const { row, envelope } of candidates) {
        planOf.set(row.id, {
          kind: 'planned',
          envelope,
          outcomes: await planNotifications(envelope, lookups),
        });
      }
      existing = await this.existingKeys(planOf);
    } catch (err) {
      const failure = classifyFailure(err);
      if (failure.result === 'transient') {
        report.transientFailures += 1;
        metrics.count('failed', { result: 'transient', reason: failure.reason });
        logger.warn(
          { reason: failure.reason, ...errorFields(err) },
          '[NotificationEventReconciliation] page could not be read; ending the run',
        );
        return { handledUpTo: null, aborted: 'transient_db', stoppedAt: page[0]!.publishedAt };
      }
      throw err;
    }

    let handledUpTo: ReconciliationCursor | null = null;
    for (const row of page) {
      const plan = planOf.get(row.id);
      if (plan?.kind === 'planned') {
        const aborted = await this.reconcileEvent(row, plan, existing, context);
        if (aborted) return { handledUpTo, aborted, stoppedAt: row.publishedAt };
      }
      handledUpTo = { publishedAt: row.publishedAt, id: row.id };
    }
    return { handledUpTo, aborted: null, stoppedAt: null };
  }

  private async reconcileEvent(
    row: PublishedOutboxEvent,
    plan: Extract<EventPlan, { kind: 'planned' }>,
    existing: Set<string>,
    context: RunContext,
  ): Promise<'transient_db' | 'queue_unavailable' | null> {
    const { now, mode, report, metrics } = context;
    const eventType = { event_type: row.eventType };
    for (const outcome of plan.outcomes) {
      if (outcome.kind === 'skip') {
        report.skipped += 1;
        metrics.count('skipped', { ...eventType, reason: outcome.reason });
        continue;
      }
      if (outcome.kind === 'lookup_failed') {
        this.permanent(
          row,
          context,
          outcome.error instanceof InvalidReferenceError ? 'invalid_data' : 'lookup_failed',
          outcome.error,
        );
        continue;
      }
      if (existing.has(outcome.plan.input.idempotencyKey)) {
        report.present += 1;
        metrics.count('present', eventType);
        continue;
      }
      if (mode === 'dry-run') {
        report.wouldRecover += 1;
        metrics.count('would_recover', eventType);
        continue;
      }

      let written: WriteOutcome;
      try {
        written = await writeNotificationPlan(
          plan.envelope,
          outcome.plan,
          this.notificationRepository,
        );
      } catch (err) {
        const failure = classifyFailure(err);
        if (failure.result === 'transient') {
          report.transientFailures += 1;
          metrics.count('failed', { ...eventType, result: 'transient', reason: failure.reason });
          logger.warn(
            { ...rowFields(row), reason: failure.reason, ...errorFields(err) },
            '[NotificationEventReconciliation] transient failure; ending the run at this event',
          );
          return 'transient_db';
        }
        this.permanent(row, context, failure.reason, err);
        continue;
      }

      if (written.kind === 'duplicate') {
        report.duplicate += 1;
        metrics.count('duplicate', eventType);
        continue;
      }
      const category = { ...eventType, category: outcome.plan.deliveryClass };
      const ageSeconds = Math.max(0, (now.getTime() - row.createdAt.getTime()) / 1000);
      report.recovered += 1;
      metrics.count('recovered', category);
      metrics.count('recovered_age_seconds_total', eventType, ageSeconds);
      context.recoveredAgeMaxSeconds = Math.max(context.recoveredAgeMaxSeconds, ageSeconds);
      logger.info(
        { ...rowFields(row), notificationId: written.notificationId, outcome: written.kind },
        '[NotificationEventReconciliation] recovered a missing notification',
      );
      if (written.kind === 'enqueue_failed') {
        // The row is QUEUED and PA-11 will enqueue it. A timeout means Redis is
        // unreachable: stop rather than spend the bound on every remaining event.
        report.enqueueFailed += 1;
        metrics.count('enqueue_failed', category);
        if (written.error instanceof EnqueueTimeoutError) return 'queue_unavailable';
      }
    }
    return null;
  }

  /// The planner's two reads, served from one query per table for the page.
  private async preload(envelopes: EventEnvelope[]): Promise<NotificationLookups> {
    const rideIds = [
      ...new Set(
        envelopes
          .map((envelope) => (envelope.data as { rideId?: unknown }).rideId)
          .filter((id): id is string => typeof id === 'string' && isUuid(id)),
      ),
    ];
    const rides =
      rideIds.length === 0
        ? []
        : await this.db.client.ride.findMany({
            where: { id: { in: rideIds } },
            select: { id: true, customerId: true, driverId: true },
          });
    const driverIds = [...new Set(rides.map((ride) => ride.driverId))];
    const drivers =
      driverIds.length === 0
        ? []
        : await this.db.client.driver.findMany({
            where: { id: { in: driverIds } },
            select: { id: true, userId: true },
          });
    const rideById = new Map(
      rides.map((ride) => [ride.id, { customerId: ride.customerId, driverId: ride.driverId }]),
    );
    const driverById = new Map(drivers.map((driver) => [driver.id, { userId: driver.userId }]));
    return {
      async findRide(rideId) {
        if (!isUuid(rideId)) throw new InvalidReferenceError('ride');
        return rideById.get(rideId) ?? null;
      },
      async findDriver(driverId) {
        if (!isUuid(driverId)) throw new InvalidReferenceError('driver');
        return driverById.get(driverId) ?? null;
      },
    };
  }

  /// A read made only for a metric: its failure costs the metric, never the run.
  private async observe(read: () => Promise<number>): Promise<number | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  private async existingKeys(planOf: Map<string, EventPlan>): Promise<Set<string>> {
    const keys = [...planOf.values()].flatMap((plan) =>
      plan.kind === 'planned'
        ? plan.outcomes.flatMap((o) => (o.kind === 'notify' ? [o.plan.input.idempotencyKey] : []))
        : [],
    );
    if (keys.length === 0) return new Set();
    const rows = await this.db.client.notification.findMany({
      where: { idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    });
    return new Set(rows.flatMap((row) => (row.idempotencyKey ? [row.idempotencyKey] : [])));
  }

  /// Recorded and moved past: retrying cannot change the outcome. Logged without
  /// the payload, the notification copy, or a raw Prisma error (whose message can
  /// echo the query's arguments).
  private permanent(
    row: PublishedOutboxEvent,
    context: RunContext,
    reason: string,
    err?: unknown,
  ): void {
    context.report.permanentFailures += 1;
    context.metrics.count('failed', { event_type: row.eventType, result: 'permanent', reason });
    logger.error(
      { ...rowFields(row), reason, ...(err === undefined ? {} : errorFields(err)) },
      '[NotificationEventReconciliation] event cannot be reconciled; skipping it',
    );
  }
}

function rowFields(row: PublishedOutboxEvent): Record<string, string> {
  return { outboxId: row.id, eventId: row.eventId, eventType: row.eventType };
}

function prismaCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorFields(err: unknown): Record<string, unknown> {
  if (PrismaErrorMapper.isPrismaError(err)) {
    return { errName: (err as Error).name, code: prismaCode(err) };
  }
  return { err };
}
