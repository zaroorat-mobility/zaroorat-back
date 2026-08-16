import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma';
import { Decimal, type RideRequest, type RideRequestStatus } from '../types';
export interface CreateRideRequestInput {
  customerId: string;
  vehicleTypeId: string;
  pickupLat: Decimal;
  pickupLng: Decimal;
  pickupAddress?: string | null;
  dropLat?: Decimal | null;
  dropLng?: Decimal | null;
  dropAddress?: string | null;
  estimatedDistanceKm?: Decimal | null;
  estimatedDurationMin?: number | null;
  quotedFare?: Decimal | null;
  surgeMultiplier?: Decimal;
  paymentMethod?: string | null;
  promoCode?: string | null;
  scheduledFor?: Date | null;
  expiresAt?: Date | null;
}
export class RideRequestRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(input: CreateRideRequestInput, tx?: TransactionClient): Promise<RideRequest> {
    const client = tx ?? this.db.client;
    const id = randomUUID();
    const hasDrop = input.dropLat != null && input.dropLng != null;
    await client.$executeRaw`
      INSERT INTO "ride_requests" (
        "id", "customer_id", "vehicle_type_id",
        "pickup_lat", "pickup_lng", "pickup_location", "pickup_address",
        "drop_lat", "drop_lng", "drop_location", "drop_address",
        "estimated_distance_km", "estimated_duration_min", "quoted_fare",
        "surge_multiplier", "payment_method", "promo_code",
        "scheduled_for", "status", "created_at", "expires_at"
      ) VALUES (
        ${id}::uuid, ${input.customerId}::uuid, ${input.vehicleTypeId}::uuid,
        ${input.pickupLat}, ${input.pickupLng},
        ST_SetSRID(ST_MakePoint(${input.pickupLng.toNumber()}, ${input.pickupLat.toNumber()}), 4326)::geography,
        ${input.pickupAddress ?? null},
        ${input.dropLat ?? null}, ${input.dropLng ?? null},
        ${
          hasDrop
            ? Prisma.sql`ST_SetSRID(ST_MakePoint(${input.dropLng!.toNumber()}, ${input.dropLat!.toNumber()}), 4326)::geography`
            : Prisma.sql`NULL`
        },
        ${input.dropAddress ?? null},
        ${input.estimatedDistanceKm ?? null}, ${input.estimatedDurationMin ?? null},
        ${input.quotedFare ?? null},
        ${input.surgeMultiplier ?? new Decimal(1)},
        ${input.paymentMethod ?? null}, ${input.promoCode ?? null},
        ${input.scheduledFor ?? null}, 'CREATED'::"RideRequestStatus",
        now(), ${input.expiresAt ?? null}
      )
    `;
    return client.rideRequest.findUniqueOrThrow({ where: { id } });
  }
  async findById(id: string, tx?: TransactionClient): Promise<RideRequest | null> {
    const client = tx ?? this.db.client;
    return client.rideRequest.findUnique({
      where: { id },
    });
  }
  async findActiveByCustomer(
    customerId: string,
    tx?: TransactionClient,
  ): Promise<RideRequest | null> {
    const client = tx ?? this.db.client;
    return client.rideRequest.findFirst({
      where: {
        customerId,
        status: { in: ['CREATED', 'SEARCHING'] },
      },
    });
  }
  async updateStatus(
    id: string,
    status: RideRequestStatus,
    tx?: TransactionClient,
  ): Promise<RideRequest> {
    const client = tx ?? this.db.client;
    return client.rideRequest.update({
      where: { id },
      data: { status },
    });
  }
  async lockForUpdate(id: string, tx: TransactionClient): Promise<RideRequest | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "ride_requests" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.rideRequest.findUnique({ where: { id } });
  }
  async claimForMatch(id: string, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.rideRequest.updateMany({
      where: { id, status: { in: ['CREATED', 'SEARCHING'] } },
      data: { status: 'MATCHED' },
    });
    return count === 1;
  }
}
