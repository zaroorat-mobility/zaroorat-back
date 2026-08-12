import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type RideFare } from '../types';

export interface CreateRideFareInput {
  rideId: string;
  baseFare: Decimal;
  distanceFare: Decimal;
  timeFare: Decimal;
  waitingCharge?: Decimal;
  surgeMultiplier?: Decimal;
  surgeAmount?: Decimal;
  subtotal: Decimal;
  discountAmount?: Decimal;
  taxAmount?: Decimal;
  tollAmount?: Decimal;
  platformFee?: Decimal;
  tipAmount?: Decimal;
  totalFare: Decimal;
  driverEarning: Decimal;
  platformCommission: Decimal;
}

export class RideFareRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateRideFareInput, tx?: TransactionClient): Promise<RideFare> {
    const client = tx ?? this.db.client;

    const data = {
      rideId: input.rideId,
      currency: 'INR',
      baseFare: input.baseFare,
      distanceFare: input.distanceFare,
      timeFare: input.timeFare,
      waitingCharge: input.waitingCharge ?? new Decimal(0),
      surgeMultiplier: input.surgeMultiplier ?? new Decimal(1.0),
      surgeAmount: input.surgeAmount ?? new Decimal(0),
      subtotal: input.subtotal,
      discountAmount: input.discountAmount ?? new Decimal(0),
      taxAmount: input.taxAmount ?? new Decimal(0),
      tollAmount: input.tollAmount ?? new Decimal(0),
      platformFee: input.platformFee ?? new Decimal(0),
      tipAmount: input.tipAmount ?? new Decimal(0),
      totalFare: input.totalFare,
      driverEarning: input.driverEarning,
      platformCommission: input.platformCommission,
    };

    return client.rideFare.create({ data });
  }

  async findByRideId(rideId: string, tx?: TransactionClient): Promise<RideFare | null> {
    const client = tx ?? this.db.client;
    return client.rideFare.findUnique({
      where: { rideId },
    });
  }
}
