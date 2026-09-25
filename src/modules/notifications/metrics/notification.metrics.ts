import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

/// The three counters Phase A needs in order to be verifiable at all.
///
/// Not the full observability surface (spec §27) — that is Phase 9, and it also
/// needs `@core/metrics` extended with a histogram type before the latency
/// series in §27.2 can exist. These three are the ones whose absence makes
/// Phase A unfalsifiable:
///
/// - `created`          the denominator for every delivery-rate ratio
/// - `enqueue_failed`   the signal that the PA-11 reconciliation sweep is
///                      covering a real Redis failure rather than idling
/// - `no_active_device` the single metric that would have surfaced the driver
///                      Expo-token defect within minutes of its release, and
///                      the one that will move when PA-5 starts excluding
///                      revoked devices
///
/// Label discipline: only keys in `SAFE_LABELS` survive the registry, which is
/// what keeps a userId or rideId out of a metric label. `event_type` and
/// `category` are the only two used here, and both are bounded sets.
/// Plain functions rather than an injected class, unlike `SessionMetrics`.
/// Counters are stateless and `@core/metrics` is already a module-level registry,
/// so a constructor dependency would buy nothing — and it would force every
/// existing consumer test harness to grow an argument, including the one that
/// asserts notification failures stay isolated from ride and payment state.
/// That test is load-bearing and is not worth churning to inject a counter.
export type NotificationMetricFields = Record<string, string | number | boolean>;

function emit(event: string, fields?: NotificationMetricFields): void {
  incrementCounter(`notification_${event}`, fields);
  logger.info({ metric: `notification.${event}`, ...fields }, `[metric] notification.${event}`);
}

export function notificationCreated(fields?: NotificationMetricFields): void {
  emit('created', fields);
}

/// `queue.add` threw. The Notification row is committed and the job is not; the
/// reconciliation sweep is what recovers it.
export function notificationEnqueueFailed(fields?: NotificationMetricFields): void {
  emit('enqueue_failed', fields);
}

/// The recipient has no device holding a usable push token. A sustained rise
/// means tokens are not arriving, or are being cleared faster than registered.
export function notificationNoActiveDevice(fields?: NotificationMetricFields): void {
  emit('no_active_device', fields);
}

// ── Reconciliation sweep (PA-11) ─────────────────────────────────────────────
//
// One counter per outcome. Labels are bounded sets only: `status` is a BullMQ
// job state, `reason` a fixed code — never an id.

/// A stale QUEUED notification the sweep looked at.
export function notificationReconciliationScanned(fields?: NotificationMetricFields): void {
  emit('reconciliation_scanned', fields);
}

/// Its delivery job was missing (or finished with work left) and was enqueued again.
export function notificationReconciliationReenqueued(fields?: NotificationMetricFields): void {
  emit('reconciliation_reenqueued', fields);
}

/// Its delivery job is live in BullMQ (waiting, prioritized, delayed, active), so
/// nothing was done.
export function notificationReconciliationSkippedActive(fields?: NotificationMetricFields): void {
  emit('reconciliation_skipped_active', fields);
}

/// Settled FAILED instead of being enqueued: the offer window or the delivery TTL
/// had already passed.
export function notificationReconciliationExpired(fields?: NotificationMetricFields): void {
  emit('reconciliation_expired', fields);
}

/// Settled from state that already existed: a terminally failed job, or
/// deliveries that were all terminal.
export function notificationReconciliationSettled(fields?: NotificationMetricFields): void {
  emit('reconciliation_settled', fields);
}

/// A candidate could not be reconciled. `reason: queue_unavailable` also ends
/// the sweep early.
export function notificationReconciliationError(fields?: NotificationMetricFields): void {
  emit('reconciliation_error', fields);
}
