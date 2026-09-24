import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma';
import { Decimal, type RideRequest, type RideRequestStatus } from '../types';
import { CLIENT_REQUEST_INCLUDE } from '../presenters/ride-client.presenter.js';

export type RideRequestClientRow = RideRequest & {
  vehicleType?: { id: string; name: string; code: string } | null;
  stops?: Array<{
    sequence: number;
    lat: Decimal;
    lng: Decimal;
    address: string | null;
  }>;
};
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
  /// FR-002. The pricing rule the quote resolved, so completion can bill on it.
  pricingRuleId?: string | null;
  paymentMethod?: string | null;
  promoCode?: string | null;
  scheduledFor?: Date | null;
  expiresAt?: Date | null;
  mapProvider?: string | null;
  mapConfigVersion?: number | null;
  passengerName?: string | null;
  passengerPhone?: string | null;
  pickupNotes?: string | null;
  boostAmount?: Decimal | null;
}
export interface RideRequestStopInput {
  lat: number;
  lng: number;
  address?: string | null;
}
export interface RideRequestStopRow {
  id: string;
  requestId: string;
  sequence: number;
  lat: Decimal;
  lng: Decimal;
  address: string | null;
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
        "surge_multiplier", "pricing_rule_id", "payment_method", "promo_code",
        "scheduled_for", "status", "created_at", "expires_at",
        "map_provider", "map_config_version",
        "passenger_name", "passenger_phone", "pickup_notes", "boost_amount"
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
        ${input.pricingRuleId ?? null}::uuid,
        ${input.paymentMethod ?? null}, ${input.promoCode ?? null},
        ${input.scheduledFor ?? null}, 'CREATED'::"RideRequestStatus",
        now(), ${input.expiresAt ?? null},
        ${input.mapProvider ?? null}, ${input.mapConfigVersion ?? null},
        ${input.passengerName ?? null}, ${input.passengerPhone ?? null},
        ${input.pickupNotes ?? null}, ${input.boostAmount ?? null}
      )
    `;
    return client.rideRequest.findUniqueOrThrow({ where: { id } });
  }
  /// Raw insert because `location` is a PostGIS column Prisma cannot write.
  async createStops(
    requestId: string,
    stops: readonly RideRequestStopInput[],
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.db.client;
    for (const [index, stop] of stops.entries()) {
      await client.$executeRaw`
        INSERT INTO "ride_request_stops" (
          "id", "request_id", "sequence", "lat", "lng", "location", "address", "created_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${requestId}::uuid, ${index + 1},
          ${new Decimal(stop.lat)}, ${new Decimal(stop.lng)},
          ST_SetSRID(ST_MakePoint(${stop.lng}, ${stop.lat}), 4326)::geography,
          ${stop.address ?? null}, now()
        )
      `;
    }
  }
  async findStops(requestId: string, tx?: TransactionClient): Promise<RideRequestStopRow[]> {
    const client = tx ?? this.db.client;
    return client.rideRequestStop.findMany({
      where: { requestId },
      select: { id: true, requestId: true, sequence: true, lat: true, lng: true, address: true },
      orderBy: { sequence: 'asc' },
    });
  }
  async updateBoost(
    id: string,
    boostAmount: Decimal,
    tx?: TransactionClient,
  ): Promise<RideRequest> {
    const client = tx ?? this.db.client;
    return client.rideRequest.update({ where: { id }, data: { boostAmount } });
  }
  /// Moves the drop and re-pins the quote the completion path floors and caps
  /// the bill against, so a longer destination is billed as a longer trip.
  async updateDestination(
    id: string,
    input: {
      dropLat: number;
      dropLng: number;
      dropAddress: string | null;
      estimatedDistanceKm: Decimal;
      estimatedDurationMin: number;
      quotedFare: Decimal;
    },
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.db.client;
    await client.$executeRaw`
      UPDATE "ride_requests" SET
        "drop_lat" = ${new Decimal(input.dropLat)},
        "drop_lng" = ${new Decimal(input.dropLng)},
        "drop_location" = ST_SetSRID(ST_MakePoint(${input.dropLng}, ${input.dropLat}), 4326)::geography,
        "drop_address" = ${input.dropAddress},
        "estimated_distance_km" = ${input.estimatedDistanceKm},
        "estimated_duration_min" = ${input.estimatedDurationMin},
        "quoted_fare" = ${input.quotedFare}
      WHERE "id" = ${id}::uuid
    `;
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
        // A future scheduled booking is not a live search; it must not block
        // an instant one (mirrors `ride_requests_active_customer_key`).
        scheduledFor: null,
      },
    });
  }
  async findActiveDetailByCustomer(
    customerId: string,
    tx?: TransactionClient,
  ): Promise<RideRequestClientRow | null> {
    const client = tx ?? this.db.client;
    return client.rideRequest.findFirst({
      where: {
        customerId,
        status: { in: ['CREATED', 'SEARCHING'] },
        scheduledFor: null,
      },
      include: CLIENT_REQUEST_INCLUDE,
    });
  }
  async findByIdWithClientInclude(
    id: string,
    tx?: TransactionClient,
  ): Promise<RideRequestClientRow | null> {
    const client = tx ?? this.db.client;
    return client.rideRequest.findUnique({
      where: { id },
      include: CLIENT_REQUEST_INCLUDE,
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
