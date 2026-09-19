import { DatabaseService } from '@core/database';
import { Decimal } from '../../types';

export type EarningsPeriod = 'today' | 'week' | 'month';

export interface EarningsBreakdownItem {
  labelKey: string;
  amount: number;
  tone?: 'positive' | 'negative' | 'neutral';
  showPlus?: boolean;
}

export interface EarningsTripItem {
  id: string;
  title: string;
  time: string;
  distanceKm: number;
  amount: number;
}

export interface EarningsSummary {
  total: number;
  previousTotal: number;
  growthPercent: number;
  trips: number;
  hoursOnline: number;
  cashCollected: number;
  commissionOwed: number;
  autoSettled: number;
  balancePayable: number;
  commissionPercent: number;
  breakdown: EarningsBreakdownItem[];
  tripWise: EarningsTripItem[];
}

export interface DailyEarningBucket {
  date: string;
  total: number;
  trips: number;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function periodWindow(
  period: EarningsPeriod,
  now = new Date(),
): { start: Date; end: Date; previousStart: Date; previousEnd: Date } {
  const end = now;
  let start: Date;
  if (period === 'today') {
    start = startOfUtcDay(now);
  } else if (period === 'week') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  const durationMs = end.getTime() - start.getTime();
  const previousEnd = start;
  const previousStart = new Date(start.getTime() - Math.max(durationMs, 1));
  return { start, end, previousStart, previousEnd };
}

export class DriverEarningsService {
  constructor(private readonly db: DatabaseService) {}

  async getSummary(driverId: string, period: EarningsPeriod): Promise<EarningsSummary> {
    const { start, end, previousStart, previousEnd } = periodWindow(period);
    const [current, previous, hoursOnline, autoSettled, wallet] = await Promise.all([
      this.aggregateRides(driverId, start, end),
      this.aggregateRides(driverId, previousStart, previousEnd),
      this.sumHoursOnline(driverId, start, end),
      this.sumAutoSettled(driverId, start, end),
      this.db.client.driverWallet.findUnique({ where: { driverId } }),
    ]);

    const growthPercent =
      previous.total <= 0
        ? current.total > 0
          ? 100
          : 0
        : Math.round(((current.total - previous.total) / previous.total) * 1000) / 10;

    const tripWise = await this.listTripWise(driverId, start, end, 20);
    const commissionPercent =
      current.grossFare > 0
        ? Math.round((current.commissionOwed / current.grossFare) * 1000) / 10
        : 0;

    const breakdown: EarningsBreakdownItem[] = [
      {
        labelKey: 'earnings.trip_fares',
        amount: current.grossFare,
        tone: 'neutral',
        showPlus: true,
      },
      {
        labelKey: 'earnings.driver_share',
        amount: current.total,
        tone: 'positive',
        showPlus: true,
      },
      {
        labelKey: 'earnings.commission',
        amount: current.commissionOwed,
        tone: 'negative',
      },
      {
        labelKey: 'earnings.cash_collected',
        amount: current.cashCollected,
        tone: 'neutral',
      },
    ];

    return {
      total: round2(current.total),
      previousTotal: round2(previous.total),
      growthPercent,
      trips: current.trips,
      hoursOnline: round2(hoursOnline),
      cashCollected: round2(current.cashCollected),
      commissionOwed: round2(current.commissionOwed),
      autoSettled: round2(autoSettled),
      balancePayable: round2(Number(wallet?.balance ?? 0)),
      commissionPercent,
      breakdown,
      tripWise,
    };
  }

  async getDaily(driverId: string, from: Date, to: Date): Promise<{ data: DailyEarningBucket[] }> {
    const rows = await this.db.client.$queryRaw<
      { day: Date; total: Decimal | number; trips: bigint | number }[]
    >`
      SELECT date_trunc('day', r."completed_at") AS day,
             COALESCE(SUM(f."driver_earning"), 0) AS total,
             COUNT(*)::int AS trips
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${from}
        AND r."completed_at" < ${to}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return {
      data: rows.map((row) => ({
        date: new Date(row.day).toISOString().slice(0, 10),
        total: round2(Number(row.total)),
        trips: Number(row.trips),
      })),
    };
  }

  async listCompletedRides(
    driverId: string,
    opts: { from?: Date; to?: Date; cursor?: string; limit: number },
  ): Promise<{
    data: Array<{
      id: string;
      rideCode: string;
      completedAt: string | null;
      distanceKm: number | null;
      durationMin: number | null;
      pickupAddress: string | null;
      dropAddress: string | null;
      driverEarning: number;
      totalFare: number;
      paymentMethod: string;
    }>;
    nextCursor: string | null;
  }> {
    const limit = opts.limit;
    let cursorCompletedAt: Date | undefined;
    if (opts.cursor) {
      const cursorRide = await this.db.client.ride.findUnique({
        where: { id: opts.cursor },
        select: { completedAt: true },
      });
      cursorCompletedAt = cursorRide?.completedAt ?? undefined;
    }

    const rides = await this.db.client.ride.findMany({
      where: {
        driverId,
        status: 'COMPLETED',
        ...(opts.from || opts.to
          ? {
              completedAt: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lt: opts.to } : {}),
              },
            }
          : {}),
        ...(opts.cursor && cursorCompletedAt
          ? {
              OR: [
                { completedAt: { lt: cursorCompletedAt } },
                { completedAt: cursorCompletedAt, id: { lt: opts.cursor } },
              ],
            }
          : {}),
      },
      include: { fare: true },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rides.slice(0, limit);
    const next = rides.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return {
      data: page.map((ride) => ({
        id: ride.id,
        rideCode: ride.rideCode,
        completedAt: ride.completedAt?.toISOString() ?? null,
        distanceKm: ride.actualDistanceKm != null ? Number(ride.actualDistanceKm) : null,
        durationMin: ride.actualDurationMin,
        pickupAddress: ride.pickupAddress,
        dropAddress: ride.dropAddress,
        driverEarning: Number(ride.fare?.driverEarning ?? 0),
        totalFare: Number(ride.fare?.totalFare ?? 0),
        paymentMethod: ride.paymentMethod,
      })),
      nextCursor: next,
    };
  }

  private async aggregateRides(
    driverId: string,
    start: Date,
    end: Date,
  ): Promise<{
    total: number;
    trips: number;
    cashCollected: number;
    commissionOwed: number;
    grossFare: number;
  }> {
    const rows = await this.db.client.$queryRaw<
      {
        total: Decimal | number;
        trips: bigint | number;
        cash_collected: Decimal | number;
        commission_owed: Decimal | number;
        gross_fare: Decimal | number;
      }[]
    >`
      SELECT
        COALESCE(SUM(f."driver_earning"), 0) AS total,
        COUNT(*)::int AS trips,
        COALESCE(SUM(CASE WHEN r."payment_method" = 'CASH' THEN f."total_fare" ELSE 0 END), 0)
          AS cash_collected,
        COALESCE(
          SUM(
            COALESCE(
              r."commission_amount",
              f."platform_commission",
              f."total_fare" - f."driver_earning"
            )
          ),
          0
        ) AS commission_owed,
        COALESCE(SUM(f."total_fare"), 0) AS gross_fare
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${start}
        AND r."completed_at" < ${end}
    `;
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      trips: Number(row?.trips ?? 0),
      cashCollected: Number(row?.cash_collected ?? 0),
      commissionOwed: Number(row?.commission_owed ?? 0),
      grossFare: Number(row?.gross_fare ?? 0),
    };
  }

  private async sumHoursOnline(driverId: string, start: Date, end: Date): Promise<number> {
    const rows = await this.db.client.$queryRaw<{ minutes: bigint | number | null }[]>`
      SELECT COALESCE(SUM(
        CASE
          WHEN s."shift_end" IS NULL THEN
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (LEAST(${end}, NOW()) - GREATEST(s."shift_start", ${start}))) / 60
            )::int
          ELSE
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (
                LEAST(s."shift_end", ${end}) - GREATEST(s."shift_start", ${start})
              )) / 60
            )::int
        END
      ), 0) AS minutes
      FROM "driver_shift_logs" s
      WHERE s."driver_id" = ${driverId}::uuid
        AND s."shift_start" < ${end}
        AND (s."shift_end" IS NULL OR s."shift_end" > ${start})
    `;
    return Number(rows[0]?.minutes ?? 0) / 60;
  }

  /// Settlement credits already pushed into the driver earnings wallet.
  private async sumAutoSettled(driverId: string, start: Date, end: Date): Promise<number> {
    const rows = await this.db.client.$queryRaw<{ total: Decimal | number }[]>`
      SELECT COALESCE(SUM(t."amount"), 0) AS total
      FROM "driver_wallet_transactions" t
      WHERE t."driver_id" = ${driverId}::uuid
        AND t."txn_type" = 'RIDE_EARNING'::"DriverWalletTxnType"
        AND t."created_at" >= ${start}
        AND t."created_at" < ${end}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  private async listTripWise(
    driverId: string,
    start: Date,
    end: Date,
    limit: number,
  ): Promise<EarningsTripItem[]> {
    const rides = await this.db.client.ride.findMany({
      where: {
        driverId,
        status: 'COMPLETED',
        completedAt: { gte: start, lt: end },
      },
      include: { fare: true },
      orderBy: { completedAt: 'desc' },
      take: limit,
    });
    return rides.map((ride) => ({
      id: ride.id,
      title: ride.dropAddress ?? ride.pickupAddress ?? ride.rideCode,
      time: ride.completedAt?.toISOString() ?? ride.createdAt.toISOString(),
      distanceKm: ride.actualDistanceKm != null ? Number(ride.actualDistanceKm) : 0,
      amount: Number(ride.fare?.driverEarning ?? 0),
    }));
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
