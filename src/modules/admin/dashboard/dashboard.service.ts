import { DatabaseService } from '@core/database';

export interface DashboardLiveStatsDto {
  activeDrivers: number;
  activeRiders: number;
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

const REPORTING_TIME_ZONE = 'Asia/Kolkata';

export function formatIstDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function formatIstWeekday(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTING_TIME_ZONE,
    weekday: 'short',
  }).format(d);
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

export class AdminDashboardService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async getStats(): Promise<DashboardStatsDto> {
    const now = new Date();
    const todayIstStr = formatIstDate(now);
    const todayMidnightIst = new Date(`${todayIstStr}T00:00:00+05:30`);
    const trendStart = new Date(todayMidnightIst.getTime() - 6 * 24 * 60 * 60 * 1000);

    const [driverStatuses, activeRiders, ongoingRides, pendingVerifications, ledgerRows, rideRows] =
      await Promise.all([
        this.client.driverOnlineStatus.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.client.user.count({
          where: {
            deletedAt: null,
            status: 'ACTIVE',
            roleAssignments: {
              some: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                role: { slug: 'customer' },
              },
              none: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                role: { slug: { notIn: ['customer', 'driver'] } },
              },
            },
          },
        }),
        this.client.ride.count({
          where: {
            status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
          },
        }),
        this.client.driver.count({
          where: {
            verificationStatus: { in: ['PENDING', 'DOCUMENT_REVIEW'] },
          },
        }),
        this.client.$queryRaw<LedgerAggRow[]>`
        SELECT
          TO_CHAR(ple."created_at" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
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
          TO_CHAR(r."completed_at" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
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

    const onlineDrivers =
      (driverCounts['ONLINE'] ?? 0) +
      (driverCounts['ON_TRIP'] ?? 0) +
      (driverCounts['BUSY'] ?? 0) +
      (driverCounts['BREAK'] ?? 0);

    return {
      stats: {
        activeDrivers: onlineDrivers,
        activeRiders,
        ongoingRides,
        pendingVerifications,
      },
      earningTrend: this.buildEarningTrend(trendStart, ledgerRows, rideRows),
    };
  }

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
      const dayTime = new Date(start.getTime() + i * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
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
      if (row.account === 'PLATFORM_COMMISSION') {
        if (row.direction === 'CREDIT') {
          bucket.rideCommission += amount;
        } else if (row.direction === 'DEBIT') {
          bucket.rideCommission -= amount;
        }
      } else if (row.account === 'SUBSCRIPTION_REVENUE') {
        if (row.direction === 'CREDIT') {
          bucket.subscriptionRevenue += amount;
        } else if (row.direction === 'DEBIT') {
          bucket.subscriptionRevenue -= amount;
        }
      } else if (row.account === 'PLATFORM_FEE') {
        if (row.direction === 'CREDIT') {
          bucket.platformFees += amount;
        } else if (row.direction === 'DEBIT') {
          bucket.platformFees -= amount;
        }
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
      const netRevenue = Math.max(
        0,
        Math.round((netCommission + netSubscription + netFees) * 100) / 100,
      );

      return {
        date: b.date,
        platformRevenue: netRevenue,
        earnings: netRevenue, // backward-compatibility alias for platformRevenue
        rideCommission: Math.max(0, netCommission),
        subscriptionRevenue: Math.max(0, netSubscription),
        platformFees: Math.max(0, netFees),
        grossRideValue: Math.max(0, b.grossRideValue),
        ridesCount: b.ridesCount,
      };
    });
  }
}
