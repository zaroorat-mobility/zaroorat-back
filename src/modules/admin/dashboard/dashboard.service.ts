import { DatabaseService } from '@core/database';

export interface DashboardLiveStatsDto {
  activeDrivers: number;
  activeRiders: number;
  ongoingRides: number;
  pendingVerifications: number;
}

export interface DashboardEarningStatDto {
  date: string;
  earnings: number;
  ridesCount: number;
}

export interface DashboardStatsDto {
  stats: DashboardLiveStatsDto;
  earningTrend: DashboardEarningStatDto[];
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export class AdminDashboardService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async getStats(): Promise<DashboardStatsDto> {
    const now = new Date();
    const trendStart = new Date(now);
    trendStart.setDate(trendStart.getDate() - 6);
    trendStart.setHours(0, 0, 0, 0);

    const [driverStatuses, activeRiders, ongoingRides, pendingVerifications, completedRides] =
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
        this.client.ride.findMany({
          where: {
            status: 'COMPLETED',
            completedAt: { gte: trendStart },
          },
          select: {
            completedAt: true,
            fare: { select: { totalFare: true } },
          },
        }),
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
      earningTrend: this.buildEarningTrend(trendStart, completedRides),
    };
  }

  private buildEarningTrend(
    start: Date,
    rides: Array<{ completedAt: Date | null; fare: { totalFare: unknown } | null }>,
  ): DashboardEarningStatDto[] {
    const buckets = new Map<string, { earnings: number; ridesCount: number }>();

    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      buckets.set(key, { earnings: 0, ridesCount: 0 });
    }

    for (const ride of rides) {
      if (!ride.completedAt) continue;
      const key = ride.completedAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.ridesCount += 1;
      bucket.earnings += ride.fare?.totalFare ? Number(ride.fare.totalFare) : 0;
    }

    return Array.from(buckets.entries()).map(([key, value]) => {
      const date = new Date(`${key}T00:00:00.000Z`);
      return {
        date: DAY_LABELS[date.getUTCDay()] ?? key,
        earnings: Math.round(value.earnings),
        ridesCount: value.ridesCount,
      };
    });
  }
}
