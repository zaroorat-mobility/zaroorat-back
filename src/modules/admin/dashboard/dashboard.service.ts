import { DatabaseService } from '@core/database';
import { redis } from '@core/cache/client.js';
import { geoConfig, realtimeConfig } from '@config';
import { allManagedQueues, resolveQueue } from '../../../jobs/queues/index.js';
import type { RealtimeGateway } from '@modules/realtime/index.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import {
  DashboardOverviewDto,
  DashboardFinancialsDto,
  DashboardAnalyticsDto,
  DashboardFinancialAnalyticsDto,
  AnalyticsRange,
  DashboardLiveDriversResponseDto,
  DashboardLiveDriverItemDto,
  DashboardActivityResponseDto,
  DashboardActivityItemDto,
  DashboardActivityType,
  DashboardHealthDto,
  GpsFreshness,
} from './dashboard.dto.js';
import { calculateFinancials, calculatePercentageChange } from './financial.calculator.js';
import { REPORTING_TIME_ZONE, comparisonWindows, istDateKey } from './dashboard.periods.js';
import {
  aggregateHealth,
  probeGps,
  probeNotifications,
  probePaymentFailures,
} from './dashboard.health.js';
import {
  parseActivityCursor,
  parseViewport,
  type ActivityCursor,
  type ActivityQuery,
  type ActivitySource,
  type LiveDriversQuery,
} from './dashboard.schemas.js';

export interface DashboardLiveStatsDto {
  activeDrivers: number;
  activeRiders: number; // backward-compatibility alias for inFlightRiders
  inFlightRiders: number;
  ongoingRides: number;
  pendingVerifications: number;
}

export interface DashboardEarningStatDto {
  date: string;
  platformRevenue: number;
  earnings: number; // backward-compatibility alias for platformRevenue
  rideCommission: number;
  subscriptionRevenue: number;
  platformFees: number;
  grossRideValue: number;
  ridesCount: number;
}

export interface DashboardStatsDto {
  stats: DashboardLiveStatsDto;
  earningTrend: DashboardEarningStatDto[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RIDE_STATUSES = [
  'ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
] as const;
const CANCELLED_RIDE_STATUSES = [
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_DRIVER',
  'CANCELLED_BY_SYSTEM',
] as const;
const ON_DUTY_STATUSES = ['ONLINE', 'ON_TRIP', 'BUSY', 'BREAK'] as const;
/**
 * Lookback bound when reconstructing "rides ongoing at the same time yesterday"
 * from ride timestamps, so the query can use the rides.created_at index. A ride
 * accepted more than 48 h before that instant is excluded from the baseline.
 */
const ONGOING_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export function formatIstDate(d: Date): string {
  return istDateKey(d);
}

export function formatIstWeekday(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTING_TIME_ZONE,
    weekday: 'short',
  }).format(d);
}

export function degreesToCompass(deg: number | null | undefined): string {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '—';
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return directions[index] ?? '—';
}

export function formatTimeAgo(seconds: number): string {
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Vehicle mode classification (shared by the filter and the display) ─────

type VehicleMode = 'Car' | 'Auto' | 'Bike';
const AUTO_KEYS = ['AUTO'];
const BIKE_KEYS = ['BIKE', 'MOTO', 'SCOOTER'];

export function classifyVehicleMode(typeName: string, typeCode: string): VehicleMode {
  const text = `${typeName} ${typeCode}`.toUpperCase();
  if (AUTO_KEYS.some((k) => text.includes(k))) return 'Auto';
  if (BIKE_KEYS.some((k) => text.includes(k))) return 'Bike';
  return 'Car';
}

function vehicleTypeMatches(keys: string[]): Prisma.VehicleTypeWhereInput {
  return {
    OR: keys.flatMap((k) => [
      { name: { contains: k, mode: 'insensitive' as const } },
      { code: { contains: k, mode: 'insensitive' as const } },
    ]),
  };
}

function vehicleModeWhere(mode: VehicleMode): Prisma.DriverWhereInput {
  const auto = vehicleTypeMatches(AUTO_KEYS);
  const bike = vehicleTypeMatches(BIKE_KEYS);
  const vehicleType: Prisma.VehicleTypeWhereInput =
    mode === 'Auto'
      ? auto
      : mode === 'Bike'
        ? { AND: [bike, { NOT: auto }] }
        : { NOT: [auto, bike] };
  return { assignments: { some: { status: 'ACTIVE', vehicle: { vehicleType } } } };
}

// ─── Activity keyset pagination ──────────────────────────────────────────────

/**
 * Activity items are ordered by (timestamp desc, id desc) where id is
 * "<source>:<uuid>". For a source, the items strictly after the cursor are:
 * a source sorting before the cursor's source → timestamp <= cursor time;
 * after it → timestamp < cursor time; the same source → earlier timestamp, or
 * the same timestamp with a smaller uuid.
 */
function afterCursor(
  cursor: ActivityCursor | null,
  source: ActivitySource,
  field: 'createdAt' | 'approvedAt',
): Record<string, unknown> {
  if (!cursor) return {};
  if (source < cursor.source) return { [field]: { lte: cursor.at } };
  if (source > cursor.source) return { [field]: { lt: cursor.at } };
  return { OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.rawId } }] };
}

function compareActivity(a: DashboardActivityItemDto, b: DashboardActivityItemDto): number {
  const byTime = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Rejects after `ms`; the timer is always cleared. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LedgerAggRow {
  day: string;
  account: string;
  direction: string;
  total: unknown;
}

export interface RideAggRow {
  day: string;
  rides_count: number | bigint;
  gross_ride_value: unknown;
}

interface InFlightRiderCountRow {
  count: number | bigint;
}

export class AdminDashboardService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  public async getInFlightRidersCount(): Promise<number> {
    const rows = await this.client.$queryRaw<InFlightRiderCountRow[]>`
      SELECT COUNT(DISTINCT customer_id)::int AS count
      FROM (
        SELECT r."customer_id"
        FROM "rides" r
        WHERE r."status" IN (
          'ACCEPTED'::"RideStatus",
          'DRIVER_ARRIVING'::"RideStatus",
          'DRIVER_ARRIVED'::"RideStatus",
          'IN_PROGRESS'::"RideStatus",
          'DRIVER_AT_DROPOFF'::"RideStatus"
        )

        UNION

        SELECT rr."customer_id"
        FROM "ride_requests" rr
        WHERE rr."status" IN (
          'CREATED'::"RideRequestStatus",
          'SEARCHING'::"RideRequestStatus"
        )
        AND (
          rr."expires_at" IS NULL
          OR rr."expires_at" > NOW()
        )
      ) active_customers
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Operations Overview API.
   * Current snapshots, each compared with the same IST time of day yesterday
   * where history exists to reconstruct it.
   */
  public async getOverview(): Promise<DashboardOverviewDto> {
    const w = comparisonWindows(new Date());
    const x = w.sameTimeYesterday;

    const [
      driverStatuses,
      inFlightRiders,
      ongoingRides,
      pendingVerifications,
      registeredDrivers,
      completedRows,
      onDutyYesterdayRows,
      ongoingYesterdayRows,
    ] = await Promise.all([
      this.client.driverOnlineStatus.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.getInFlightRidersCount(),
      this.client.ride.count({
        where: { status: { in: [...ACTIVE_RIDE_STATUSES] } },
      }),
      this.client.driver.count({
        where: { deletedAt: null, verificationStatus: { in: ['PENDING', 'DOCUMENT_REVIEW'] } },
      }),
      this.client.driver.count({ where: { deletedAt: null } }),
      this.client.$queryRaw<Array<{ today_completed: number; yesterday_completed: number }>>`
        SELECT
          COUNT(*) FILTER (WHERE "completed_at" >= ${w.todayStart} AND "completed_at" < ${w.now})::int AS today_completed,
          COUNT(*) FILTER (WHERE "completed_at" >= ${w.yesterdayStart} AND "completed_at" < ${x})::int AS yesterday_completed
        FROM "rides"
        WHERE "status" = 'COMPLETED'::"RideStatus"
          AND "completed_at" >= ${w.yesterdayStart}
          AND "completed_at" < ${w.now}
      `,
      // Drivers on duty at X: a shift opens on setOnline and closes on every
      // path to OFFLINE (setOffline, heartbeat timeout, suspension).
      this.client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(DISTINCT "driver_id")::int AS count
        FROM "driver_shift_logs"
        WHERE "shift_start" <= ${x}
          AND ("shift_end" IS NULL OR "shift_end" > ${x})
      `,
      // Rides ongoing at X: accepted by then and not yet completed or cancelled.
      this.client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "rides"
        WHERE "created_at" > ${new Date(x.getTime() - ONGOING_LOOKBACK_MS)}
          AND "accepted_at" <= ${x}
          AND ("completed_at" IS NULL OR "completed_at" > ${x})
          AND ("cancelled_at" IS NULL OR "cancelled_at" > ${x})
      `,
    ]);

    const driverCounts: Record<string, number> = {};
    for (const row of driverStatuses) {
      driverCounts[row.status] = row._count._all;
    }

    const onlineDrivers = driverCounts['ONLINE'] ?? 0;
    const activeDrivers = ON_DUTY_STATUSES.reduce((sum, s) => sum + (driverCounts[s] ?? 0), 0);

    const onlineDriversPctOfActive =
      activeDrivers > 0 ? Math.round((onlineDrivers / activeDrivers) * 1000) / 10 : 0;

    const completedToday = Number(completedRows[0]?.today_completed ?? 0);
    const completedYesterday = Number(completedRows[0]?.yesterday_completed ?? 0);

    return {
      activeDrivers,
      activeDriversChangePct: calculatePercentageChange(
        activeDrivers,
        Number(onDutyYesterdayRows[0]?.count ?? 0),
      ),
      onlineDrivers,
      onlineDriversPctOfActive,
      ongoingRides,
      ongoingRidesChangePct: calculatePercentageChange(
        ongoingRides,
        Number(ongoingYesterdayRows[0]?.count ?? 0),
      ),
      inFlightRiders,
      completedRidesToday: completedToday,
      completedRidesYesterday: completedYesterday,
      completedRidesChangePct: calculatePercentageChange(completedToday, completedYesterday),
      pendingVerifications,
      pendingVerificationsChangePct: null,
      registeredDrivers,
      calculatedAt: w.now.toISOString(),
    };
  }

  /**
   * Operations Financials API.
   * Platform revenue is recognised on its ledger posting date. Gross ride value
   * and driver ride collections belong to the ride's completion date: the
   * commission/fee legs of a ride are attributed to that ride even when they are
   * posted later (a WALLET ride's legs post when payment is collected).
   * Today [todayStart, now) is compared with yesterday [yesterdayStart, same time).
   */
  public async getFinancials(): Promise<DashboardFinancialsDto> {
    const w = comparisonWindows(new Date());
    const x = w.sameTimeYesterday;

    const [ledgerRows, rideRows] = await Promise.all([
      this.client.$queryRaw<
        Array<{
          period: 'today' | 'yesterday';
          account: string;
          direction: string;
          total: unknown;
        }>
      >`
        SELECT
          CASE WHEN ple."created_at" >= ${w.todayStart} THEN 'today' ELSE 'yesterday' END AS period,
          ple."account" AS account,
          ple."direction" AS direction,
          COALESCE(SUM(ple."amount"), 0) AS total
        FROM "payment_ledger_entries" ple
        WHERE ple."account" IN ('PLATFORM_COMMISSION', 'SUBSCRIPTION_REVENUE', 'PLATFORM_FEE')
          AND (
            (ple."created_at" >= ${w.yesterdayStart} AND ple."created_at" < ${x})
            OR (ple."created_at" >= ${w.todayStart} AND ple."created_at" < ${w.now})
          )
        GROUP BY 1, 2, 3
      `,
      // A ride's legs are posted at or after its completion, so ledger rows
      // before yesterdayStart cannot belong to these rides.
      this.client.$queryRaw<
        Array<{
          period: 'today' | 'yesterday';
          gross: unknown;
          deductions: unknown;
        }>
      >`
        WITH completed AS (
          SELECT
            r."id",
            CASE WHEN r."completed_at" >= ${w.todayStart} THEN 'today' ELSE 'yesterday' END AS period
          FROM "rides" r
          WHERE r."status" = 'COMPLETED'::"RideStatus"
            AND (
              (r."completed_at" >= ${w.yesterdayStart} AND r."completed_at" < ${x})
              OR (r."completed_at" >= ${w.todayStart} AND r."completed_at" < ${w.now})
            )
        ),
        ride_legs AS (
          SELECT
            ple."reference_id" AS ride_id,
            SUM(CASE WHEN ple."direction" = 'CREDIT' THEN ple."amount" ELSE -ple."amount" END) AS deductions
          FROM "payment_ledger_entries" ple
          WHERE ple."account" IN ('PLATFORM_COMMISSION', 'PLATFORM_FEE')
            AND ple."reference_type" = 'RIDE'
            AND ple."created_at" >= ${w.yesterdayStart}
            AND ple."reference_id" IN (SELECT "id" FROM completed)
          GROUP BY 1
        )
        SELECT
          c.period,
          COALESCE(SUM(f."total_fare"), 0) AS gross,
          COALESCE(SUM(l.deductions), 0) AS deductions
        FROM completed c
        LEFT JOIN "ride_fares" f ON f."ride_id" = c."id"
        LEFT JOIN ride_legs l ON l.ride_id = c."id"
        GROUP BY 1
      `,
    ]);

    const ledgerTotals = {
      today: { commission: 0, fees: 0, subscription: 0 },
      yesterday: { commission: 0, fees: 0, subscription: 0 },
    };

    for (const row of ledgerRows) {
      const p = row.period;
      if (!ledgerTotals[p]) continue;
      const signed = (row.direction === 'CREDIT' ? 1 : -1) * Number(row.total);

      if (row.account === 'PLATFORM_COMMISSION') {
        ledgerTotals[p].commission += signed;
      } else if (row.account === 'PLATFORM_FEE') {
        ledgerTotals[p].fees += signed;
      } else if (row.account === 'SUBSCRIPTION_REVENUE') {
        ledgerTotals[p].subscription += signed;
      }
    }

    const rides = { today: { gross: 0, deductions: 0 }, yesterday: { gross: 0, deductions: 0 } };
    for (const row of rideRows) {
      if (row.period === 'today' || row.period === 'yesterday') {
        rides[row.period] = { gross: Number(row.gross), deductions: Number(row.deductions) };
      }
    }

    const revenue = (p: 'today' | 'yesterday') =>
      calculateFinancials({
        grossRideValue: rides[p].gross,
        rideCommission: ledgerTotals[p].commission,
        platformFees: ledgerTotals[p].fees,
        subscriptionRevenue: ledgerTotals[p].subscription,
      }).platformRevenue;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const collections = (p: 'today' | 'yesterday') => round2(rides[p].gross - rides[p].deductions);

    const platformRevenueToday = revenue('today');
    const platformRevenueYesterday = revenue('yesterday');
    const grossRideValueToday = round2(rides.today.gross);
    const grossRideValueYesterday = round2(rides.yesterday.gross);
    const driverRideCollectionsToday = collections('today');
    const driverRideCollectionsYesterday = collections('yesterday');

    return {
      platformRevenueToday,
      platformRevenueYesterday,
      platformRevenueChangePct: calculatePercentageChange(
        platformRevenueToday,
        platformRevenueYesterday,
      ),

      grossRideValueToday,
      grossRideValueYesterday,
      grossRideValueChangePct: calculatePercentageChange(
        grossRideValueToday,
        grossRideValueYesterday,
      ),

      driverRideCollectionsToday,
      driverRideCollectionsYesterday,
      driverRideCollectionsChangePct: calculatePercentageChange(
        driverRideCollectionsToday,
        driverRideCollectionsYesterday,
      ),

      currency: 'INR',
      reportingTimeZone: REPORTING_TIME_ZONE,
      calculatedAt: w.now.toISOString(),
    };
  }

  async getStats(): Promise<DashboardStatsDto> {
    const now = new Date();
    const todayMidnightIst = comparisonWindows(now).todayStart;
    const trendStart = new Date(todayMidnightIst.getTime() - 6 * DAY_MS);

    const [
      driverStatuses,
      inFlightRiders,
      ongoingRides,
      pendingVerifications,
      ledgerRows,
      rideRows,
    ] = await Promise.all([
      this.client.driverOnlineStatus.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.getInFlightRidersCount(),
      this.client.ride.count({
        where: { status: { in: [...ACTIVE_RIDE_STATUSES] } },
      }),
      this.client.driver.count({
        where: { deletedAt: null, verificationStatus: { in: ['PENDING', 'DOCUMENT_REVIEW'] } },
      }),
      this.client.$queryRaw<LedgerAggRow[]>`
        SELECT
          TO_CHAR((ple."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
          ple."account" AS account,
          ple."direction" AS direction,
          COALESCE(SUM(ple."amount"), 0) AS total
        FROM "payment_ledger_entries" ple
        WHERE ple."account" IN ('PLATFORM_COMMISSION', 'SUBSCRIPTION_REVENUE', 'PLATFORM_FEE')
          AND ple."created_at" >= ${trendStart}
        GROUP BY 1, 2, 3
        ORDER BY 1 ASC
      `,
      this.client.$queryRaw<RideAggRow[]>`
        SELECT
          TO_CHAR((r."completed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS rides_count,
          COALESCE(SUM(f."total_fare"), 0) AS gross_ride_value
        FROM "rides" r
        LEFT JOIN "ride_fares" f ON f."ride_id" = r."id"
        WHERE r."status" = 'COMPLETED'::"RideStatus"
          AND r."completed_at" >= ${trendStart}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    ]);

    const driverCounts: Record<string, number> = {};
    for (const row of driverStatuses) {
      driverCounts[row.status] = row._count._all;
    }

    const onlineDrivers = ON_DUTY_STATUSES.reduce((sum, s) => sum + (driverCounts[s] ?? 0), 0);

    return {
      stats: {
        activeDrivers: onlineDrivers,
        activeRiders: inFlightRiders,
        inFlightRiders,
        ongoingRides,
        pendingVerifications,
      },
      earningTrend: this.buildEarningTrend(trendStart, ledgerRows, rideRows),
    };
  }

  /** Seven IST days of net (CREDIT − DEBIT) revenue components; signs are preserved. */
  public buildEarningTrend(
    start: Date,
    ledgerRows: LedgerAggRow[],
    rideRows: RideAggRow[],
  ): DashboardEarningStatDto[] {
    const buckets = new Map<
      string,
      {
        date: string;
        dateKey: string;
        platformRevenue: number;
        rideCommission: number;
        subscriptionRevenue: number;
        platformFees: number;
        grossRideValue: number;
        ridesCount: number;
      }
    >();

    for (let i = 0; i < 7; i++) {
      const dayTime = new Date(start.getTime() + i * DAY_MS + 12 * 60 * 60 * 1000);
      const dateKey = formatIstDate(dayTime);
      const weekday = formatIstWeekday(dayTime);
      buckets.set(dateKey, {
        date: weekday,
        dateKey,
        platformRevenue: 0,
        rideCommission: 0,
        subscriptionRevenue: 0,
        platformFees: 0,
        grossRideValue: 0,
        ridesCount: 0,
      });
    }

    for (const row of ledgerRows) {
      const bucket = buckets.get(row.day);
      if (!bucket) continue;
      const amount = Number(row.total);
      const signed = row.direction === 'CREDIT' ? amount : row.direction === 'DEBIT' ? -amount : 0;
      if (row.account === 'PLATFORM_COMMISSION') {
        bucket.rideCommission += signed;
      } else if (row.account === 'SUBSCRIPTION_REVENUE') {
        bucket.subscriptionRevenue += signed;
      } else if (row.account === 'PLATFORM_FEE') {
        bucket.platformFees += signed;
      }
    }

    for (const row of rideRows) {
      const bucket = buckets.get(row.day);
      if (!bucket) continue;
      bucket.ridesCount = Number(row.rides_count);
      bucket.grossRideValue = Math.round(Number(row.gross_ride_value) * 100) / 100;
    }

    return Array.from(buckets.values()).map((b) => {
      const netCommission = Math.round(b.rideCommission * 100) / 100;
      const netSubscription = Math.round(b.subscriptionRevenue * 100) / 100;
      const netFees = Math.round(b.platformFees * 100) / 100;
      const netRevenue = Math.round((netCommission + netSubscription + netFees) * 100) / 100;

      return {
        date: b.date,
        platformRevenue: netRevenue,
        earnings: netRevenue, // backward-compatibility alias for platformRevenue
        rideCommission: netCommission,
        subscriptionRevenue: netSubscription,
        platformFees: netFees,
        grossRideValue: b.grossRideValue,
        ridesCount: b.ridesCount,
      };
    });
  }

  /**
   * Financial Analytics API (finance:read).
   * Daily IST series over the range: platform revenue by ledger posting date
   * (net CREDIT − DEBIT, signs preserved) and gross ride value by ride completion date.
   */
  public async getFinancialAnalytics(
    range: AnalyticsRange = '7d',
  ): Promise<DashboardFinancialAnalyticsDto> {
    const daysCount = range === '90d' ? 90 : range === '30d' ? 30 : 7;
    const w = comparisonWindows(new Date());
    const startCutoff = new Date(w.todayStart.getTime() - (daysCount - 1) * DAY_MS);

    const [ledgerRows, fareRows] = await Promise.all([
      this.client.$queryRaw<
        Array<{
          day_key: string;
          account: string;
          direction: string;
          total: unknown;
        }>
      >`
        SELECT
          TO_CHAR((ple."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day_key,
          ple."account" AS account,
          ple."direction" AS direction,
          COALESCE(SUM(ple."amount"), 0) AS total
        FROM "payment_ledger_entries" ple
        WHERE ple."account" IN ('PLATFORM_COMMISSION', 'SUBSCRIPTION_REVENUE', 'PLATFORM_FEE')
          AND ple."created_at" >= ${startCutoff}
          AND ple."created_at" < ${w.tomorrowStart}
        GROUP BY 1, 2, 3
      `,
      this.client.$queryRaw<
        Array<{
          day_key: string;
          rides_count: number | bigint;
          gross_ride_value: unknown;
        }>
      >`
        SELECT
          TO_CHAR((r."completed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day_key,
          COUNT(r."id")::int AS rides_count,
          COALESCE(SUM(f."total_fare"), 0) AS gross_ride_value
        FROM "rides" r
        LEFT JOIN "ride_fares" f ON f."ride_id" = r."id"
        WHERE r."status" = 'COMPLETED'::"RideStatus"
          AND r."completed_at" >= ${startCutoff}
          AND r."completed_at" < ${w.tomorrowStart}
        GROUP BY 1
      `,
    ]);

    const platformTrendMap = new Map<
      string,
      {
        date: string;
        dayOfWeek: string;
        dateKey: string;
        platformRevenue: number;
        rideCommission: number;
        subscriptionRevenue: number;
        platformFees: number;
      }
    >();

    const grossTrendMap = new Map<
      string,
      {
        date: string;
        dayOfWeek: string;
        dateKey: string;
        grossRideValue: number;
        ridesCount: number;
      }
    >();

    for (let i = 0; i < daysCount; i++) {
      const dayTime = new Date(startCutoff.getTime() + i * DAY_MS + 12 * 60 * 60 * 1000);
      const dateKey = formatIstDate(dayTime);
      const dayOfWeek = formatIstWeekday(dayTime);
      const date = new Intl.DateTimeFormat('en-IN', {
        timeZone: REPORTING_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(dayTime);

      platformTrendMap.set(dateKey, {
        date,
        dayOfWeek,
        dateKey,
        platformRevenue: 0,
        rideCommission: 0,
        subscriptionRevenue: 0,
        platformFees: 0,
      });

      grossTrendMap.set(dateKey, {
        date,
        dayOfWeek,
        dateKey,
        grossRideValue: 0,
        ridesCount: 0,
      });
    }

    for (const row of ledgerRows) {
      const bucket = platformTrendMap.get(row.day_key);
      if (!bucket) continue;
      const signed = (row.direction === 'CREDIT' ? 1 : -1) * Number(row.total);
      if (row.account === 'PLATFORM_COMMISSION') {
        bucket.rideCommission += signed;
      } else if (row.account === 'PLATFORM_FEE') {
        bucket.platformFees += signed;
      } else if (row.account === 'SUBSCRIPTION_REVENUE') {
        bucket.subscriptionRevenue += signed;
      }
    }

    for (const b of platformTrendMap.values()) {
      b.rideCommission = Math.round(b.rideCommission * 100) / 100;
      b.platformFees = Math.round(b.platformFees * 100) / 100;
      b.subscriptionRevenue = Math.round(b.subscriptionRevenue * 100) / 100;
      b.platformRevenue =
        Math.round((b.rideCommission + b.platformFees + b.subscriptionRevenue) * 100) / 100;
    }

    for (const row of fareRows) {
      const bucket = grossTrendMap.get(row.day_key);
      if (!bucket) continue;
      bucket.ridesCount = Number(row.rides_count);
      bucket.grossRideValue = Math.round(Number(row.gross_ride_value) * 100) / 100;
    }

    return {
      range,
      platformRevenueTrend: Array.from(platformTrendMap.values()),
      grossRideValueTrend: Array.from(grossTrendMap.values()),
      reportingTimeZone: REPORTING_TIME_ZONE,
      calculatedAt: w.now.toISOString(),
    };
  }

  /**
   * Operational Analytics API (operations:read): today's demand outcomes and
   * rides by hour, in IST.
   */
  public async getAnalytics(): Promise<DashboardAnalyticsDto> {
    const w = comparisonWindows(new Date());

    const [statusCounts, noDriverRows, hourCounts] = await Promise.all([
      this.client.$queryRaw<Array<{ completed: number; cancelled: number; ongoing: number }>>`
        SELECT
          COUNT(*) FILTER (WHERE "status" = 'COMPLETED'::"RideStatus")::int AS completed,
          COUNT(*) FILTER (WHERE "status" IN ('CANCELLED_BY_CUSTOMER'::"RideStatus", 'CANCELLED_BY_DRIVER'::"RideStatus", 'CANCELLED_BY_SYSTEM'::"RideStatus"))::int AS cancelled,
          COUNT(*) FILTER (WHERE "status" IN ('ACCEPTED'::"RideStatus", 'DRIVER_ARRIVING'::"RideStatus", 'DRIVER_ARRIVED'::"RideStatus", 'IN_PROGRESS'::"RideStatus", 'DRIVER_AT_DROPOFF'::"RideStatus"))::int AS ongoing
        FROM "rides"
        WHERE "created_at" >= ${w.todayStart}
          AND "created_at" < ${w.tomorrowStart}
      `,
      // A request no driver accepted before it timed out (RequestExpiryJob).
      this.client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "ride_requests"
        WHERE "status" = 'EXPIRED'::"RideRequestStatus"
          AND "created_at" >= ${w.todayStart}
          AND "created_at" < ${w.tomorrowStart}
      `,
      this.client.$queryRaw<Array<{ hour_val: number; count: number }>>`
        SELECT
          EXTRACT(HOUR FROM ((r."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'))::int AS hour_val,
          COUNT(*)::int AS count
        FROM "rides" r
        WHERE r."created_at" >= ${w.todayStart}
          AND r."created_at" < ${w.tomorrowStart}
        GROUP BY 1
      `,
    ]);

    const completed = Number(statusCounts[0]?.completed ?? 0);
    const cancelled = Number(statusCounts[0]?.cancelled ?? 0);
    const ongoing = Number(statusCounts[0]?.ongoing ?? 0);
    const noDriversFound = Number(noDriverRows[0]?.count ?? 0);
    const total = completed + cancelled + ongoing + noDriversFound;
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    const hourMap = new Map<number, number>();
    for (const r of hourCounts) {
      hourMap.set(Number(r.hour_val), Number(r.count));
    }
    const maxHourlyCount = Math.max(0, ...hourMap.values());

    const ridesByHour = [];
    for (let h = 0; h < 24; h++) {
      const count = hourMap.get(h) ?? 0;
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
      ridesByHour.push({ hour: h, label, count, isPeak: count === maxHourlyCount && count > 0 });
    }

    return {
      rideStatusDistribution: {
        total,
        completed,
        completedPct: pct(completed),
        cancelled,
        cancelledPct: pct(cancelled),
        noDriversFound,
        noDriversFoundPct: pct(noDriversFound),
        ongoing,
        ongoingPct: pct(ongoing),
      },
      ridesByHour,
      periodStart: w.todayStart.toISOString(),
      periodEnd: w.tomorrowStart.toISOString(),
      reportingTimeZone: REPORTING_TIME_ZONE,
      calculatedAt: w.now.toISOString(),
    };
  }

  /**
   * Live Drivers API.
   * On-duty drivers (ONLINE, ON_TRIP, BUSY, BREAK) by default — or exactly the
   * requested status — freshest GPS fix first. GPS freshness uses the dispatch
   * threshold (geoConfig.candidateStalenessSeconds): a position older than that
   * is not used for matching, so it is not shown as live either.
   */
  public async getLiveDrivers(query: LiveDriversQuery): Promise<DashboardLiveDriversResponseDto> {
    const now = Date.now();
    const staleAfterSec = geoConfig.candidateStalenessSeconds;
    const bounds = query.viewport ? parseViewport(query.viewport) : null;

    const statusWhere: Prisma.DriverWhereInput =
      query.status === 'OFFLINE'
        ? { OR: [{ onlineStatus: null }, { onlineStatus: { status: 'OFFLINE' } }] }
        : {
            onlineStatus: { status: { in: query.status ? [query.status] : [...ON_DUTY_STATUSES] } },
          };

    const baseWhere: Prisma.DriverWhereInput = {
      deletedAt: null,
      AND: [
        statusWhere,
        ...(query.mode ? [vehicleModeWhere(query.mode)] : []),
        ...(bounds
          ? [
              {
                location: {
                  latitude: { gte: bounds.minLat, lte: bounds.maxLat },
                  longitude: { gte: bounds.minLng, lte: bounds.maxLng },
                },
              },
            ]
          : []),
      ],
    };
    const include = {
      profile: true,
      user: { include: { profile: true } },
      onlineStatus: true,
      location: true,
      assignments: {
        where: { status: 'ACTIVE' as const },
        include: { vehicle: { include: { vehicleType: true } } },
        take: 1,
      },
      rides: {
        where: { status: { in: [...ACTIVE_RIDE_STATUSES] } },
        select: { id: true, rideCode: true, status: true },
        take: 1,
      },
    } satisfies Prisma.DriverInclude;

    const [countRows, withGps] = await Promise.all([
      // Every non-deleted driver has exactly one status; no row means never online (OFFLINE).
      this.client.$queryRaw<Array<{ status: string; count: number }>>`
        SELECT COALESCE(s."status"::text, 'OFFLINE') AS status, COUNT(*)::int AS count
        FROM "drivers" d
        LEFT JOIN "driver_online_status" s ON s."driver_id" = d."id"
        WHERE d."deleted_at" IS NULL
        GROUP BY 1
      `,
      // Freshest GPS fix first …
      this.client.driver.findMany({
        where: { AND: [baseWhere, { location: { isNot: null } }] },
        include,
        orderBy: [{ location: { recordedAt: 'desc' } }, { id: 'asc' }],
        take: query.limit,
      }),
    ]);
    // … then drivers with no fix at all (none can match a viewport).
    const withoutGps =
      withGps.length < query.limit && !bounds
        ? await this.client.driver.findMany({
            where: { AND: [baseWhere, { location: null }] },
            include,
            orderBy: { id: 'asc' },
            take: query.limit - withGps.length,
          })
        : [];
    const driverRows = [...withGps, ...withoutGps];

    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.status] = Number(row.count);

    const drivers: DashboardLiveDriverItemDto[] = driverRows.map((d) => {
      const status = (d.onlineStatus?.status ?? 'OFFLINE') as DashboardLiveDriverItemDto['status'];
      const vehicle = d.assignments[0]?.vehicle ?? null;
      const vehicleType = vehicle?.vehicleType ?? null;
      const activeRide = d.rides[0] ?? null;

      let location: DashboardLiveDriverItemDto['location'] = null;
      let speedKmh: number | null = null;
      let heading: string | null = null;
      let recordedAt: string | null = null;
      let gpsLagSeconds: number | null = null;
      let lastUpdateText = 'No GPS signal';
      let gpsFreshness: GpsFreshness = status === 'OFFLINE' ? 'OFFLINE' : 'UNKNOWN';

      const loc = d.location;
      if (loc && loc.latitude !== null && loc.longitude !== null) {
        location = { lat: Number(loc.latitude), lng: Number(loc.longitude) };
        speedKmh = loc.speedKmh === null ? null : Number(loc.speedKmh);
        heading = loc.heading === null ? null : degreesToCompass(Number(loc.heading));
        recordedAt = loc.recordedAt.toISOString();
        gpsLagSeconds = Math.max(0, Math.floor((now - loc.recordedAt.getTime()) / 1000));
        lastUpdateText = formatTimeAgo(gpsLagSeconds);
        if (status !== 'OFFLINE') gpsFreshness = gpsLagSeconds <= staleAfterSec ? 'LIVE' : 'STALE';
      }

      const fullName =
        d.profile?.fullLegalName ||
        [d.user?.profile?.firstName, d.user?.profile?.lastName].filter(Boolean).join(' ') ||
        'Driver';

      return {
        id: d.id,
        driverNumber: d.driverCode,
        fullName,
        phoneNumber: d.user?.phoneNumber || '',
        avatarUrl: d.profile?.profilePhoto || null,
        status,
        mode: vehicleType ? classifyVehicleMode(vehicleType.name, vehicleType.code) : null,
        vehicle: vehicle
          ? {
              id: vehicle.id,
              licensePlate: vehicle.registrationNumber,
              model: vehicle.model,
              typeCode: vehicleType?.code ?? '',
              typeName: vehicleType?.name ?? '',
            }
          : null,
        location,
        speedKmh,
        heading,
        activeTrip: activeRide
          ? { id: activeRide.id, rideCode: activeRide.rideCode, status: activeRide.status }
          : null,
        recordedAt,
        gpsFreshness,
        gpsLagSeconds,
        lastUpdateText,
      };
    });

    const onlineCount = counts['ONLINE'] ?? 0;
    const onTripCount = counts['ON_TRIP'] ?? 0;
    const busyCount = counts['BUSY'] ?? 0;
    const breakCount = counts['BREAK'] ?? 0;
    const offlineCount = counts['OFFLINE'] ?? 0;

    return {
      totalDrivers: onlineCount + onTripCount + busyCount + breakCount + offlineCount,
      onlineCount,
      onTripCount,
      busyCount,
      breakCount,
      offlineCount,
      gpsStaleAfterSec: staleAfterSec,
      drivers,
      calculatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Operational Activity Timeline API.
   * Sources: ride completions/cancellations (ride_status_events), driver
   * registrations and KYC approvals (drivers), and — only for callers who may
   * read the audit log — admin actions (admin_activity_logs) without their
   * before/after metadata. Keyset-paginated by (timestamp, id).
   */
  public async getActivity(
    query: ActivityQuery,
    options: { includeAdminActions: boolean },
  ): Promise<DashboardActivityResponseDto> {
    const limit = query.limit;
    const take = limit + 1;
    const cursor = query.cursor ? parseActivityCursor(query.cursor) : null;
    const wants = (...types: DashboardActivityType[]) => !query.type || types.includes(query.type);

    const rideToStatuses: string[] = [
      ...(wants('RIDE_COMPLETED') ? ['COMPLETED'] : []),
      ...(wants('RIDE_CANCELLED') ? [...CANCELLED_RIDE_STATUSES] : []),
    ];

    const [rideEvents, registeredDrivers, approvedDrivers, adminLogs] = await Promise.all([
      rideToStatuses.length > 0
        ? this.client.rideStatusEvent.findMany({
            where: {
              toStatus: { in: rideToStatuses },
              ...afterCursor(cursor, 'ride', 'createdAt'),
            },
            include: {
              ride: {
                select: {
                  rideCode: true,
                  customer: {
                    select: { profile: { select: { firstName: true, lastName: true } } },
                  },
                  driver: { select: { profile: { select: { fullLegalName: true } } } },
                },
              },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          })
        : [],
      wants('DRIVER_REGISTERED')
        ? this.client.driver.findMany({
            where: afterCursor(cursor, 'reg', 'createdAt'),
            select: {
              id: true,
              driverCode: true,
              createdAt: true,
              profile: { select: { fullLegalName: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          })
        : [],
      wants('KYC_APPROVED')
        ? this.client.driver.findMany({
            where: {
              AND: [{ approvedAt: { not: null } }, afterCursor(cursor, 'kyc', 'approvedAt')],
            },
            select: {
              id: true,
              driverCode: true,
              approvedAt: true,
              profile: { select: { fullLegalName: true } },
            },
            orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
            take,
          })
        : [],
      options.includeAdminActions && wants('ADMIN_ACTION')
        ? this.client.adminActivityLog.findMany({
            where: afterCursor(cursor, 'admin', 'createdAt'),
            select: {
              id: true,
              action: true,
              entityType: true,
              entityId: true,
              summary: true,
              createdAt: true,
              actor: { select: { profile: { select: { firstName: true, lastName: true } } } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          })
        : [],
    ]);

    const nowMs = Date.now();
    const timeAgo = (d: Date) =>
      formatTimeAgo(Math.max(0, Math.floor((nowMs - d.getTime()) / 1000)));
    const items: DashboardActivityItemDto[] = [];

    for (const ev of rideEvents) {
      const isCompleted = ev.toStatus === 'COMPLETED';
      const rideCode = ev.ride?.rideCode ?? ev.rideId.slice(0, 8);
      const driverName = ev.ride?.driver?.profile?.fullLegalName ?? 'Driver';
      const customerName = ev.ride?.customer?.profile
        ? [ev.ride.customer.profile.firstName, ev.ride.customer.profile.lastName]
            .filter(Boolean)
            .join(' ')
        : 'Passenger';
      items.push({
        id: `ride:${ev.id}`,
        type: isCompleted ? 'RIDE_COMPLETED' : 'RIDE_CANCELLED',
        title: isCompleted ? `Ride #${rideCode} Completed` : `Ride #${rideCode} Cancelled`,
        description: isCompleted
          ? `Ride #${rideCode} completed by ${driverName} for ${customerName}`
          : `Ride #${rideCode} was cancelled${ev.reason ? ` (${ev.reason})` : ''}`,
        entityType: 'ride',
        entityId: ev.rideId,
        actorName: driverName,
        timestamp: ev.createdAt.toISOString(),
        timeAgoText: timeAgo(ev.createdAt),
        metadata: { rideCode, reason: ev.reason ?? null, toStatus: ev.toStatus },
      });
    }

    for (const d of registeredDrivers) {
      const driverName = d.profile?.fullLegalName || d.driverCode;
      items.push({
        id: `reg:${d.id}`,
        type: 'DRIVER_REGISTERED',
        title: 'New Driver Registered',
        description: `${driverName} registered on the platform`,
        entityType: 'driver',
        entityId: d.id,
        actorName: driverName,
        timestamp: d.createdAt.toISOString(),
        timeAgoText: timeAgo(d.createdAt),
        metadata: { driverCode: d.driverCode },
      });
    }

    for (const d of approvedDrivers) {
      if (!d.approvedAt) continue;
      const driverName = d.profile?.fullLegalName || d.driverCode;
      items.push({
        id: `kyc:${d.id}`,
        type: 'KYC_APPROVED',
        title: 'Driver KYC Approved',
        description: `${driverName}'s profile and documents were approved`,
        entityType: 'driver',
        entityId: d.id,
        actorName: 'System / Admin',
        timestamp: d.approvedAt.toISOString(),
        timeAgoText: timeAgo(d.approvedAt),
        metadata: { driverCode: d.driverCode },
      });
    }

    for (const log of adminLogs) {
      const actorName =
        [log.actor?.profile?.firstName, log.actor?.profile?.lastName].filter(Boolean).join(' ') ||
        'Administrator';
      items.push({
        id: `admin:${log.id}`,
        type: 'ADMIN_ACTION',
        title: `Admin Action: ${log.action}`,
        description: log.summary || `${log.action} on ${log.entityType}`,
        entityType: 'system',
        ...(log.entityId ? { entityId: log.entityId } : {}),
        actorName,
        timestamp: log.createdAt.toISOString(),
        timeAgoText: timeAgo(log.createdAt),
      });
    }

    items.sort(compareActivity);
    const page = items.slice(0, limit);
    const hasMore = items.length > limit;
    const last = page[page.length - 1];

    return {
      activities: page,
      hasMore,
      nextCursor: hasMore && last ? `${last.timestamp}|${last.id}` : null,
      calculatedAt: new Date(nowMs).toISOString(),
    };
  }

  /**
   * System Health API. Each metric is exactly what its field name says; a probe
   * that fails reports DOWN / UNAVAILABLE with a null value, never HEALTHY.
   */
  public async getHealth(): Promise<DashboardHealthDto> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - DAY_MS);

    // 1. PostgreSQL round-trip
    let databaseLatencyMs: number | null = null;
    let databaseStatus: DashboardHealthDto['databaseStatus'];
    try {
      const start = Date.now();
      await withTimeout(this.client.$queryRawUnsafe('SELECT 1'), 2000, 'DB_TIMEOUT');
      databaseLatencyMs = Date.now() - start;
      databaseStatus = databaseLatencyMs > 500 ? 'DEGRADED' : 'HEALTHY';
    } catch {
      databaseStatus = 'DOWN';
    }

    // 2. Redis
    let redisStatus: DashboardHealthDto['redisStatus'];
    try {
      const res = await withTimeout(redis.ping(), 2000, 'REDIS_TIMEOUT');
      redisStatus = res === 'PONG' ? 'HEALTHY' : 'DEGRADED';
    } catch {
      redisStatus = 'DOWN';
    }

    // 3. Socket.IO on this API instance
    let websocketConnections: number | null = null;
    let websocketStatus: DashboardHealthDto['websocketStatus'] = 'UNAVAILABLE';
    if (!realtimeConfig.enabled) {
      websocketStatus = 'DISABLED';
    } else {
      try {
        const { container } = await import('@core/di.js');
        if (container.hasRegistration('realtimeGateway')) {
          const gateway = container.resolve<RealtimeGateway>('realtimeGateway');
          websocketConnections = gateway.connectionCount;
          websocketStatus = gateway.isRunning ? 'HEALTHY' : 'DOWN';
        }
      } catch {
        websocketStatus = 'UNAVAILABLE';
      }
    }

    // 4–6. GPS, notifications and online payments (definitions in dashboard.health.ts)
    const [gps, notifications, payments] = await Promise.all([
      probeGps(
        async () => {
          const rows = await this.client.$queryRaw<Array<{ on_duty: number; latest: Date | null }>>`
            SELECT COUNT(*)::int AS on_duty, MAX(dl."recorded_at") AS latest
            FROM "driver_online_status" s
            LEFT JOIN "driver_locations" dl ON dl."driver_id" = s."driver_id"
            WHERE s."status" <> 'OFFLINE'::"DriverStatus"
          `;
          return {
            onDutyDrivers: Number(rows[0]?.on_duty ?? 0),
            latestRecordedAt: rows[0]?.latest ?? null,
          };
        },
        now,
        geoConfig.candidateStalenessSeconds,
      ),
      probeNotifications(async () =>
        (
          await this.client.notificationDelivery.groupBy({
            by: ['status'],
            where: { createdAt: { gte: oneDayAgo } },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
      ),
      probePaymentFailures(async () =>
        (
          await this.client.paymentTransaction.groupBy({
            by: ['status'],
            where: { createdAt: { gte: oneDayAgo } },
            _count: { _all: true },
          })
        ).map((g) => ({ status: g.status, count: g._count._all })),
      ),
    ]);

    // 7. Failed jobs retained by the managed queues (only measurable with Redis up)
    let failedQueueJobs: number | null = null;
    if (redisStatus === 'HEALTHY') {
      try {
        const counts = await Promise.all(
          allManagedQueues().map(async (qInfo) => {
            const q = resolveQueue(qInfo.name);
            return q ? q.getFailedCount() : 0;
          }),
        );
        failedQueueJobs = counts.reduce((acc, c) => acc + c, 0);
      } catch {
        failedQueueJobs = null;
      }
    }

    const statuses = {
      databaseStatus,
      redisStatus,
      websocketStatus,
      notificationStatus: notifications.notificationStatus,
      gpsFreshnessStatus: gps.gpsFreshnessStatus,
      paymentFailureStatus: payments.paymentFailureStatus,
    };

    return {
      databaseLatencyMs,
      databaseStatus,
      websocketConnections,
      websocketStatus,
      redisStatus,
      failedQueueJobs,
      ...notifications,
      ...gps,
      ...payments,
      overallStatus: aggregateHealth(statuses),
      timestamp: now.toISOString(),
    };
  }
}
