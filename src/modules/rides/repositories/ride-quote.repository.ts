import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma/index.js';
import { Decimal } from '../types/index.js';

export interface CreateRideQuoteOptionInput {
  vehicleTypeId: string;
  pricingRuleId: string | null;
  ruleVersion: number | null;
  surgeMultiplier: number;
  surgeWindowId?: string | null;
  rateCardSnapshot: Prisma.InputJsonValue;
  fareSnapshot: Prisma.InputJsonValue;
  totalFare: number;
}

export interface CreateRideQuoteInput {
  customerId?: string | null;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  stops: Prisma.InputJsonValue;
  cityCode: string;
  promoCode?: string | null;
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
  distanceSource: string;
  expiresAt: Date;
  options: readonly CreateRideQuoteOptionInput[];
}

export class RideQuoteRepository {
  constructor(private readonly db: DatabaseService) {}

  async createWithOptions(input: CreateRideQuoteInput, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    const quoteId = randomUUID();
    return client.rideQuote.create({
      data: {
        id: quoteId,
        customerId: input.customerId ?? null,
        pickupLat: new Decimal(input.pickupLat),
        pickupLng: new Decimal(input.pickupLng),
        dropLat: new Decimal(input.dropLat),
        dropLng: new Decimal(input.dropLng),
        stops: input.stops,
        cityCode: input.cityCode,
        promoCode: input.promoCode ?? null,
        estimatedDistanceKm: new Decimal(input.estimatedDistanceKm),
        estimatedDurationMin: input.estimatedDurationMin,
        distanceSource: input.distanceSource,
        expiresAt: input.expiresAt,
        options: {
          create: input.options.map((opt) => ({
            id: randomUUID(),
            vehicleTypeId: opt.vehicleTypeId,
            pricingRuleId: opt.pricingRuleId,
            ruleVersion: opt.ruleVersion,
            surgeMultiplier: new Decimal(opt.surgeMultiplier),
            surgeWindowId: opt.surgeWindowId ?? null,
            rateCardSnapshot: opt.rateCardSnapshot,
            fareSnapshot: opt.fareSnapshot,
            totalFare: new Decimal(opt.totalFare),
          })),
        },
      },
      include: { options: true },
    });
  }

  async findByIdWithOptions(id: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.rideQuote.findUnique({
      where: { id },
      include: { options: true },
    });
  }

  /// Atomically marks a quote consumed if it has not been consumed and has not expired.
  /// Returns true if this caller won the claim, false otherwise.
  async consumeIfValid(id: string, now: Date, tx: TransactionClient): Promise<boolean> {
    const updated = await tx.rideQuote.updateMany({
      where: {
        id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        consumedAt: now,
      },
    });
    return updated.count === 1;
  }
}
