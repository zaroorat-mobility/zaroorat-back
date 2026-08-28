import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type Ride, type RideStatus } from '../types';
export interface CreateRideInput {
  requestId: string;
  customerId: string;
  driverId: string;
  vehicleId: string;
  vehicleTypeId: string;
  paymentMethod: 'CASH' | 'WALLET' | 'CARD' | 'UPI';
  pickupLat: Decimal;
  pickupLng: Decimal;
  pickupAddress?: string | null;
  dropLat?: Decimal | null;
  dropLng?: Decimal | null;
  dropAddress?: string | null;
  isScheduled?: boolean;
}
export class RideRepository {
  constructor(private readonly db: DatabaseService) {}
  async lockForUpdate(id: string, tx: TransactionClient): Promise<Ride | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "rides" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.ride.findUnique({ where: { id } });
  }
  async create(input: CreateRideInput, tx?: TransactionClient): Promise<Ride> {
    const client = tx ?? this.db.client;
    const rideCode = `RIDE_${Date.now().toString(36).toUpperCase()}_${randomUUID().substring(0, 4).toUpperCase()}`;
    const id = randomUUID();
    const hasDrop = input.dropLat != null && input.dropLng != null;
    await client.$executeRaw`
      INSERT INTO "rides" (
        "id", "ride_code", "request_id", "customer_id", "driver_id",
        "vehicle_id", "vehicle_type_id", "status", "payment_method",
        "payment_status", "pickup_location", "pickup_address",
        "drop_location", "drop_address", "accepted_at",
        "wait_time_min", "is_scheduled", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${rideCode}, ${input.requestId}::uuid, ${input.customerId}::uuid,
        ${input.driverId}::uuid, ${input.vehicleId}::uuid, ${input.vehicleTypeId}::uuid,
        'ACCEPTED'::"RideStatus", ${input.paymentMethod}::"PaymentMethod",
        'PENDING'::"PaymentStatus",
        ST_SetSRID(ST_MakePoint(${input.pickupLng.toNumber()}, ${input.pickupLat.toNumber()}), 4326)::geography,
        ${input.pickupAddress ?? null},
        ${
          hasDrop
            ? Prisma.sql`ST_SetSRID(ST_MakePoint(${input.dropLng!.toNumber()}, ${input.dropLat!.toNumber()}), 4326)::geography`
            : Prisma.sql`NULL`
        },
        ${input.dropAddress ?? null}, now(),
        0, ${input.isScheduled ?? false}, now(), now()
      )
    `;
    return client.ride.findUniqueOrThrow({ where: { id } });
  }
  async findById(id: string, tx?: TransactionClient): Promise<Ride | null> {
    const client = tx ?? this.db.client;
    return client.ride.findUnique({
      where: { id },
      include: {
        fare: true,
        cancellation: true,
        statusEvents: true,
        driver: { select: { userId: true } },
      },
    });
  }
  async findActiveByCustomer(customerId: string, tx?: TransactionClient): Promise<Ride | null> {
    const client = tx ?? this.db.client;
    return client.ride.findFirst({
      where: {
        customerId,
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
    });
  }
  async findActiveByDriver(driverId: string, tx?: TransactionClient): Promise<Ride | null> {
    const client = tx ?? this.db.client;
    return client.ride.findFirst({
      where: {
        driverId,
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
    });
  }
  /// The one live ride a user is party to, on either side.
  ///
  /// Replaces `findActiveByDriverUserId`, which only ever had one caller and
  /// only ever asked half the question: `GET /rides/active` picked which of the
  /// two lookups to run from the caller's roles, and every verified driver
  /// keeps the `driver` role while riding as a passenger. Asking the ride
  /// instead removes the guess, and costs one query rather than two.
  async findActiveForUser(userId: string, tx?: TransactionClient): Promise<Ride | null> {
    const client = tx ?? this.db.client;
    return client.ride.findFirst({
      where: {
        OR: [{ customerId: userId }, { driver: { userId } }],
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
      // A user should never have two, but if they somehow do, the one they most
      // recently became part of is the one they are asking about.
      orderBy: { createdAt: 'desc' },
    });
  }
  async updateStatus(
    id: string,
    status: RideStatus,
    extraData?: {
      arrivedAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
      cancelledAt?: Date;
      actualDistanceKm?: Decimal;
      actualDurationMin?: number;
      paymentStatus?: 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED';
    },
    tx?: TransactionClient,
  ): Promise<Ride> {
    const client = tx ?? this.db.client;
    const data = { status, ...extraData };
    return client.ride.update({
      where: { id },
      data,
    });
  }
  async updateStatusIf(
    id: string,
    expectedStatus: RideStatus,
    status: RideStatus,
    extraData: {
      arrivedAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
      cancelledAt?: Date;
      actualDistanceKm?: Decimal;
      actualDurationMin?: number;
      paymentStatus?: 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED';
    } = {},
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.ride.updateMany({
      where: { id, status: expectedStatus },
      data: { status, ...extraData },
    });
    return count === 1;
  }
  /// Conditional claim on the *payment* status, as `updateStatusIf` is for the
  /// ride status.
  ///
  /// The two are not interchangeable and that distinction is the whole reason
  /// this exists: `updateStatusIf` claims on `status` and can only *set*
  /// `paymentStatus` as a side effect, so nothing could claim on the payment
  /// status itself. Every collection transition needs exactly that — one
  /// winner decided by the database, whether the contenders are two retries,
  /// a retry racing the sweep, or a driver's cash confirmation racing the
  /// automatic resolution.
  ///
  /// Returns false when someone else already moved the row. The caller turns
  /// that into the right outcome — usually a harmless no-op — rather than
  /// overwriting a decision that has already been made.
  async claimPaymentStatusIf(
    id: string,
    expectedPaymentStatus: 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED',
    paymentStatus: 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED',
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.ride.updateMany({
      where: { id, paymentStatus: expectedPaymentStatus },
      data: { paymentStatus },
    });
    return count === 1;
  }
  async listCustomerRides(customerId: string, limit = 20, tx?: TransactionClient): Promise<Ride[]> {
    const client = tx ?? this.db.client;
    return client.ride.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { fare: true },
    });
  }
}
