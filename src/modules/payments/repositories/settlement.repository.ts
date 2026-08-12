import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverSettlement } from '../types';

export class SettlementRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    data: {
      driverId: string;
      periodStart: Date;
      periodEnd: Date;
      grossEarnings: Decimal;
      commission: Decimal;
      adjustments: Decimal;
      netPayable: Decimal;
    },
    tx?: TransactionClient,
  ): Promise<DriverSettlement> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.create({
      data: {
        driverId: data.driverId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        grossEarnings: data.grossEarnings,
        commission: data.commission,
        adjustments: data.adjustments,
        netPayable: data.netPayable,
        status: 'PENDING',
      },
    });
  }

  async findByDriverAndPeriod(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<DriverSettlement | null> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.findUnique({
      where: {
        driverId_periodStart_periodEnd: {
          driverId,
          periodStart,
          periodEnd,
        },
      },
    });
  }

  async aggregateEarnings(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<{
    collectedFare: Decimal;
    commission: Decimal;
    driverEarning: Decimal;
    rideCount: number;
  }> {
    const client = tx ?? this.db.client;

    const rows = await client.$queryRaw<
      {
        collected_fare: Decimal | null;
        commission: Decimal | null;
        driver_earning: Decimal | null;
        ride_count: bigint;
      }[]
    >`
      SELECT
        COALESCE(SUM(f."total_fare") FILTER (WHERE r."payment_method" <> 'CASH'), 0)
          AS collected_fare,
        COALESCE(SUM(f."platform_commission"), 0) AS commission,
        COALESCE(SUM(f."driver_earning"), 0)      AS driver_earning,
        COUNT(*)                                  AS ride_count
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${periodStart}
        AND r."completed_at" <  ${periodEnd}
    `;

    const row = rows[0];
    return {
      collectedFare: new Decimal(row?.collected_fare ?? 0),
      commission: new Decimal(row?.commission ?? 0),
      driverEarning: new Decimal(row?.driver_earning ?? 0),
      rideCount: Number(row?.ride_count ?? 0),
    };
  }

  async lockForUpdate(id: string, tx: TransactionClient): Promise<DriverSettlement | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "driver_settlements" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;

    return tx.driverSettlement.findUnique({ where: { id } });
  }

  async updateStatus(
    id: string,
    status: string,
    tx?: TransactionClient,
  ): Promise<DriverSettlement> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.update({
      where: { id },
      data: { status },
    });
  }
}
