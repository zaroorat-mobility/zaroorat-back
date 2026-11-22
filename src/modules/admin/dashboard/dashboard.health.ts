/**
 * System-health metric definitions for the operations dashboard.
 *
 * Every summary distinguishes "measured and fine" from "nothing to measure"
 * (NO_DATA) and "could not measure" (UNAVAILABLE). A probe that throws never
 * reports HEALTHY.
 */

import type { DashboardHealthDto } from './dashboard.dto.js';

export interface StatusCount {
  status: string;
  count: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// ─── Notifications ───────────────────────────────────────────────────────────

/**
 * notification_deliveries.status (NotificationStatus). SENT, DELIVERED, READ and
 * FAILED are the terminal states (notification-delivery.job.ts `TERMINAL`);
 * PENDING and QUEUED are still in flight and are not counted either way.
 */
const NOTIFICATION_SUCCESS = new Set(['SENT', 'DELIVERED', 'READ']);
const NOTIFICATION_FAILURE = new Set(['FAILED']);
/** Existing product threshold: below 90 % successful delivery is degraded. */
const NOTIFICATION_HEALTHY_MIN_PCT = 90;

export type NotificationHealth = Pick<
  DashboardHealthDto,
  'notificationSuccessRate' | 'notificationStatus'
>;

export function summarizeNotifications(rows: StatusCount[]): NotificationHealth {
  let success = 0;
  let failed = 0;
  for (const r of rows) {
    if (NOTIFICATION_SUCCESS.has(r.status)) success += r.count;
    else if (NOTIFICATION_FAILURE.has(r.status)) failed += r.count;
  }
  const settled = success + failed;
  if (settled === 0) return { notificationSuccessRate: null, notificationStatus: 'NO_DATA' };
  const rate = round1((success / settled) * 100);
  return {
    notificationSuccessRate: rate,
    notificationStatus: rate >= NOTIFICATION_HEALTHY_MIN_PCT ? 'HEALTHY' : 'DEGRADED',
  };
}

export async function probeNotifications(
  fetch: () => Promise<StatusCount[]>,
): Promise<NotificationHealth> {
  try {
    return summarizeNotifications(await fetch());
  } catch {
    return { notificationSuccessRate: null, notificationStatus: 'UNAVAILABLE' };
  }
}

// ─── Online payment failures ─────────────────────────────────────────────────

/**
 * payment_transactions are online gateway payment attempts (payment intents:
 * subscriptions, wallet and commission top-ups). Only SUCCEEDED and FAILED are
 * settled outcomes; CANCELLED (payer abandoned) and in-flight gateway states are
 * excluded, so they neither inflate nor dilute the failure rate.
 */
/** Existing product thresholds (percent of settled payments). */
const PAYMENT_FAILURE_WARNING_PCT = 5;
const PAYMENT_FAILURE_CRITICAL_PCT = 10;

export type PaymentFailureHealth = Pick<
  DashboardHealthDto,
  'paymentFailureRate24h' | 'paymentFailureStatus'
>;

export function summarizePaymentTransactions(rows: StatusCount[]): PaymentFailureHealth {
  let succeeded = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === 'SUCCEEDED') succeeded += r.count;
    else if (r.status === 'FAILED') failed += r.count;
  }
  const settled = succeeded + failed;
  if (settled === 0) return { paymentFailureRate24h: null, paymentFailureStatus: 'NO_DATA' };
  const rate = round1((failed / settled) * 100);
  return {
    paymentFailureRate24h: rate,
    paymentFailureStatus:
      rate > PAYMENT_FAILURE_CRITICAL_PCT
        ? 'CRITICAL'
        : rate > PAYMENT_FAILURE_WARNING_PCT
          ? 'WARNING'
          : 'HEALTHY',
  };
}

export async function probePaymentFailures(
  fetch: () => Promise<StatusCount[]>,
): Promise<PaymentFailureHealth> {
  try {
    return summarizePaymentTransactions(await fetch());
  } catch {
    return { paymentFailureRate24h: null, paymentFailureStatus: 'UNAVAILABLE' };
  }
}

// ─── GPS freshness ───────────────────────────────────────────────────────────

export interface GpsSample {
  /** Drivers currently on duty (driver_online_status other than OFFLINE) */
  onDutyDrivers: number;
  /** Most recent driver_locations.recorded_at among those drivers, if any */
  latestRecordedAt: Date | null;
}

export type GpsHealth = Pick<DashboardHealthDto, 'gpsFreshnessSec' | 'gpsFreshnessStatus'>;

/**
 * NO_DATA when nobody is on duty (no fix is expected). STALE when on-duty
 * drivers exist but the newest fix among them is older than `staleAfterSec`
 * (or none exists) — the telemetry pipeline is not delivering.
 */
export function summarizeGps(sample: GpsSample, now: Date, staleAfterSec: number): GpsHealth {
  if (sample.onDutyDrivers === 0) return { gpsFreshnessSec: null, gpsFreshnessStatus: 'NO_DATA' };
  if (!sample.latestRecordedAt) return { gpsFreshnessSec: null, gpsFreshnessStatus: 'STALE' };
  const lag = Math.max(0, Math.floor((now.getTime() - sample.latestRecordedAt.getTime()) / 1000));
  return { gpsFreshnessSec: lag, gpsFreshnessStatus: lag <= staleAfterSec ? 'LIVE' : 'STALE' };
}

export async function probeGps(
  fetch: () => Promise<GpsSample>,
  now: Date,
  staleAfterSec: number,
): Promise<GpsHealth> {
  try {
    return summarizeGps(await fetch(), now, staleAfterSec);
  } catch {
    return { gpsFreshnessSec: null, gpsFreshnessStatus: 'UNAVAILABLE' };
  }
}

// ─── Overall ─────────────────────────────────────────────────────────────────

export type HealthStatuses = Pick<
  DashboardHealthDto,
  | 'databaseStatus'
  | 'redisStatus'
  | 'websocketStatus'
  | 'notificationStatus'
  | 'gpsFreshnessStatus'
  | 'paymentFailureStatus'
>;

/**
 * CRITICAL: the database or Redis is down (authentication and every API need
 *   both), or online payments fail above the critical threshold.
 * DEGRADED: any other dimension is degraded, down, stale, at warning level, or
 *   could not be measured (UNAVAILABLE) — unknown health is not healthy.
 * HEALTHY: otherwise. NO_DATA (nothing to measure) and DISABLED (switched off
 *   by configuration) do not degrade the overall status.
 */
export function aggregateHealth(s: HealthStatuses): DashboardHealthDto['overallStatus'] {
  if (
    s.databaseStatus === 'DOWN' ||
    s.redisStatus === 'DOWN' ||
    s.paymentFailureStatus === 'CRITICAL'
  ) {
    return 'CRITICAL';
  }
  if (
    s.databaseStatus === 'DEGRADED' ||
    s.redisStatus === 'DEGRADED' ||
    s.websocketStatus === 'DOWN' ||
    s.websocketStatus === 'UNAVAILABLE' ||
    s.notificationStatus === 'DEGRADED' ||
    s.notificationStatus === 'UNAVAILABLE' ||
    s.gpsFreshnessStatus === 'STALE' ||
    s.gpsFreshnessStatus === 'UNAVAILABLE' ||
    s.paymentFailureStatus === 'WARNING' ||
    s.paymentFailureStatus === 'UNAVAILABLE'
  ) {
    return 'DEGRADED';
  }
  return 'HEALTHY';
}
