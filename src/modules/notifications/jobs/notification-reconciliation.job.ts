import type { Queue } from 'bullmq';
import type { Notification } from '../../../generated/prisma';
import { logger } from '@shared/logger/index.js';
import {
  ENQUEUE_TIMEOUT_MS,
  EnqueueTimeoutError,
  JOB_NAMES,
  notificationsQueue,
  raceWithTimeout,
} from '../../../jobs/queues/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import {
  resolveDeliveryPresentation,
  resolveNotificationPriority,
  resolveOfferWindow,
  type NotificationDeliveryClass,
} from '../policies/notification-priority.policy.js';
import {
  notificationReconciliationError,
  notificationReconciliationExpired,
  notificationReconciliationReenqueued,
  notificationReconciliationScanned,
  notificationReconciliationSettled,
  notificationReconciliationSkippedActive,
} from '../metrics/notification.metrics.js';
import { isDeliveryClass, type NotificationDeliveryJobData } from './notification-delivery.job.js';

/// How old a QUEUED notification must be before the sweep looks at it.
///
/// The consumer inserts the row and enqueues immediately after, giving up after
/// `ENQUEUE_TIMEOUT_MS` (2s) — so a healthy notification has its job within
/// ~2s. Anything younger than that is not evidence of loss. Correctness does not
/// rest on this number (the job id and the row lock make a premature check
/// harmless); it only keeps the sweep off rows whose enqueue is still in flight
/// and lets a short Redis blip heal through the consumer's own late `add`.
/// Upper bound: it must stay well below the shortest non-offer TTL (10 min,
/// CRITICAL) minus the one-minute sweep cadence, or reconciliation could not
/// deliver anything useful. 30s is 15× the enqueue bound and a twentieth of that
/// ceiling. Ride offers (10s window) are always past their window by then, so the
/// sweep settles them rather than sending them — never resurrects them.
export const RECONCILE_STALE_AFTER_MS = 30_000;

/// Per sweep, same bound as the payment-intent reconciliation.
export const RECONCILE_BATCH_SIZE = 100;

/// BullMQ 6 states in which the job still exists and will run (or is running).
/// A failed attempt with retries left is `delayed` (backoff) or `waiting`, never
/// `failed` — `failed` is terminal (Job.moveToFailed / shouldRetryJob).
const LIVE_STATES = new Set(['waiting', 'prioritized', 'delayed', 'active', 'waiting-children']);

export interface NotificationReconciliationReport {
  scanned: number;
  reenqueued: number;
  skippedActive: number;
  skippedLocked: number;
  expired: number;
  settled: number;
  errors: number;
  /// The queue was unreachable; the rest of the batch was left for the next run.
  aborted: boolean;
}

/// The two queue calls the sweep makes. The live queue in production; tests
/// substitute one to take Redis away.
export type ReconciliationQueue = Pick<Queue, 'getJob' | 'add'>;

export type ReconcileOutcome =
  'reenqueued' | 'skipped_active' | 'skipped_locked' | 'expired' | 'settled';

/// PA-11. Finds notifications that were persisted but whose delivery job never
/// reached BullMQ — the consumer's enqueue failed or timed out — and enqueues
/// them again under the same job id, `notification.id`.
///
/// Each candidate is decided under a `FOR UPDATE SKIP LOCKED` row lock, so two
/// sweeps never act on the same notification and a worker planning it waits for
/// the decision. The job id is the final guard: BullMQ turns a second `add` of an
/// existing id into a no-op, so a consumer `add` that lands late and a sweep's
/// `add` produce one job between them, in either order. The delivery job itself
/// is idempotent (bind-once planning, terminal deliveries never resent).
export class NotificationReconciliationJob {
  /// Where the previous sweep stopped. A notification the sweep re-enqueued, or
  /// one waiting behind a queue backlog, stays QUEUED until a worker runs it; if
  /// every sweep started from the oldest row, those would fill each batch and
  /// starve the stranded rows behind them. Continuing from here, and wrapping to
  /// the oldest once a short batch shows the end was reached, visits every
  /// candidate within ceil(candidates / batch) sweeps. In memory on purpose:
  /// correctness never depends on it (the row lock and the job id decide), and a
  /// restart merely starts over from the oldest.
  private cursor: { createdAt: Date; id: string } | null = null;

  constructor(private readonly notificationRepository: NotificationRepository) {}

  async run(
    now: Date = new Date(),
    options: { queue?: ReconciliationQueue; batchSize?: number } = {},
  ): Promise<NotificationReconciliationReport> {
    const queue = options.queue ?? notificationsQueue();
    const batchSize = options.batchSize ?? RECONCILE_BATCH_SIZE;
    const report: NotificationReconciliationReport = {
      scanned: 0,
      reenqueued: 0,
      skippedActive: 0,
      skippedLocked: 0,
      expired: 0,
      settled: 0,
      errors: 0,
      aborted: false,
    };

    const candidates = await this.notificationRepository.findStaleQueuedNotifications(
      new Date(now.getTime() - RECONCILE_STALE_AFTER_MS),
      batchSize,
      this.cursor ?? undefined,
    );

    for (const { id: notificationId } of candidates) {
      report.scanned += 1;
      notificationReconciliationScanned();
      try {
        const outcome = await this.reconcileNotification(notificationId, now, queue);
        if (outcome === 'reenqueued') report.reenqueued += 1;
        else if (outcome === 'skipped_active') report.skippedActive += 1;
        else if (outcome === 'skipped_locked') report.skippedLocked += 1;
        else if (outcome === 'expired') report.expired += 1;
        else report.settled += 1;
      } catch (err) {
        report.errors += 1;
        // A queue call that does not settle means Redis is unreachable: every
        // remaining candidate would time out the same way. The candidate's
        // transaction has rolled back, so nothing was written; the next run
        // picks the whole batch up again.
        const unavailable = err instanceof EnqueueTimeoutError;
        notificationReconciliationError({
          reason: unavailable ? 'queue_unavailable' : 'candidate',
        });
        logger.error(
          { err, notificationId },
          unavailable
            ? '[NotificationReconciliation] queue unreachable; ending the sweep early'
            : '[NotificationReconciliation] could not reconcile a notification; continuing',
        );
        if (unavailable) {
          report.aborted = true;
          break;
        }
      }
    }

    // An aborted sweep keeps its place, so the same rows are tried again. A short
    // batch reached the end of the candidates: start from the oldest next time.
    if (!report.aborted) {
      this.cursor = candidates.length < batchSize ? null : candidates[candidates.length - 1]!;
    }

    if (report.scanned > 0) {
      logger.info({ report }, '[NotificationReconciliation] sweep finished');
    }
    return report;
  }

  /// Decides one notification under its row lock. Public so concurrency can be
  /// exercised one notification at a time.
  async reconcileNotification(
    notificationId: string,
    now: Date,
    queue: ReconciliationQueue,
  ): Promise<ReconcileOutcome> {
    const outcome = await this.notificationRepository.withQueuedNotificationLocked(
      notificationId,
      async (tx, notification) => {
        const data = (notification.data ?? {}) as Record<string, unknown>;
        const deliveryClass: NotificationDeliveryClass = isDeliveryClass(data.category)
          ? data.category
          : resolveNotificationPriority(notification.eventKey).deliveryClass;
        const rideId = notification.referenceType === 'RIDE' ? notification.referenceId : null;
        const trace = {
          notificationId,
          userId: notification.userId,
          ...(typeof data.eventId === 'string' ? { eventId: data.eventId } : {}),
          ...(notification.eventKey ? { eventType: notification.eventKey } : {}),
          category: deliveryClass,
          ...(rideId ? { rideId } : {}),
        };

        const job = await raceWithTimeout(queue.getJob(notificationId), ENQUEUE_TIMEOUT_MS);
        const state = job ? await raceWithTimeout(job.getState(), ENQUEUE_TIMEOUT_MS) : 'missing';

        if (LIVE_STATES.has(state)) {
          notificationReconciliationSkippedActive({ status: state });
          return 'skipped_active' as const;
        }

        const settle = async (reason: string): Promise<'settled'> => {
          await this.notificationRepository.settleNotification(notificationId, tx);
          notificationReconciliationSettled({ reason });
          logger.warn({ ...trace, state, reason }, '[NotificationReconciliation] settled');
          return 'settled';
        };

        // Terminal in BullMQ: every attempt was used. Enqueueing again would hand
        // it a retry budget it has already spent; this is the outcome the worker's
        // exhaustion handler would have written.
        if (state === 'failed') {
          await this.notificationRepository.failQueuedDeliveries(
            notificationId,
            `Exhausted retries: ${job?.failedReason ?? 'unknown'}`,
            { tx },
          );
          return settle('job_failed');
        }

        // Nothing left to send: the status write alone was lost.
        const hasQueuedDelivery = notification.deliveries.some(
          (d) => d.status === 'QUEUED' || d.status === 'PENDING',
        );
        if (!hasQueuedDelivery) return settle('deliveries_terminal');

        // Never resurrect what can no longer be useful.
        const expiry = this.expiryOf(notification, deliveryClass, data, now);
        if (expiry) {
          await this.notificationRepository.failQueuedDeliveries(notificationId, expiry.reason, {
            errorCode: expiry.code,
            tx,
          });
          await this.notificationRepository.settleNotification(notificationId, tx);
          notificationReconciliationExpired({ reason: expiry.label, category: deliveryClass });
          logger.info(
            { ...trace, state, errorCode: expiry.code },
            '[NotificationReconciliation] not re-enqueued: expired',
          );
          return 'expired' as const;
        }

        // A completed record with deliveries still QUEUED: the job ended with work
        // left. Its record would make the `add` below a no-op, so remove it first —
        // safe under the row lock, and a completed job is not held by any worker.
        if (state === 'completed' && job) {
          await raceWithTimeout(job.remove(), ENQUEUE_TIMEOUT_MS);
        }

        // Same job, same id, same priority as the consumer's original enqueue.
        const payload: NotificationDeliveryJobData = {
          notificationId,
          deliveryId: notification.deliveries[0]!.id,
          userId: notification.userId,
          rideId,
          category: deliveryClass,
          ...(typeof data.eventId === 'string' ? { eventId: data.eventId } : {}),
          ...(notification.eventKey ? { eventType: notification.eventKey } : {}),
        };
        await raceWithTimeout(
          queue.add(JOB_NAMES.NOTIFICATION_DELIVERY, payload, {
            jobId: notificationId,
            priority: resolveNotificationPriority(notification.eventKey).bullMqPriority,
          }),
          ENQUEUE_TIMEOUT_MS,
        );
        const reason = state === 'completed' ? 'job_completed' : 'job_missing';
        notificationReconciliationReenqueued({ reason, category: deliveryClass });
        logger.warn({ ...trace, state, reason }, '[NotificationReconciliation] re-enqueued');
        return 'reenqueued' as const;
      },
    );
    return outcome ?? 'skipped_locked';
  }

  /// An offer is judged by its own window (the same `resolveOfferWindow` the
  /// worker uses); anything else by the delivery TTL of its class — the longest
  /// FCM itself would keep trying. Past either, sending now can only present
  /// something stale.
  private expiryOf(
    notification: Notification,
    deliveryClass: NotificationDeliveryClass,
    data: Record<string, unknown>,
    now: Date,
  ): { code: string; reason: string; label: string } | null {
    if (deliveryClass === 'RIDE_OFFER') {
      const window = resolveOfferWindow(data.expiresAt, now.getTime());
      if (window?.expired) {
        return {
          code: 'OFFER_EXPIRED',
          reason: 'Ride offer expired before its notification could be sent',
          label: 'offer_expired',
        };
      }
      if (window) return null;
    }
    const { ttlMs } = resolveDeliveryPresentation(deliveryClass);
    if (now.getTime() - notification.createdAt.getTime() >= ttlMs) {
      return {
        code: 'NOTIFICATION_EXPIRED',
        reason: 'Notification was never delivered to the queue and outlived its delivery TTL',
        label: 'ttl_elapsed',
      };
    }
    return null;
  }
}
