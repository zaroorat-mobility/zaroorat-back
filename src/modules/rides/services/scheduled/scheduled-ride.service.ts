import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { RideError } from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';

export class ScheduledRideNotFoundError extends RideError {
  constructor(id: string) {
    super(`Scheduled ride '${id}' was not found`, 'SCHEDULED_RIDE_NOT_FOUND', 404);
    this.name = 'ScheduledRideNotFoundError';
  }
}

export class ScheduledRideConflictError extends RideError {
  constructor(message: string) {
    super(message, 'SCHEDULED_RIDE_CONFLICT', 409);
    this.name = 'ScheduledRideConflictError';
  }
}

export class ScheduledRideService {
  constructor(
    private readonly db: DatabaseService,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async listForDriver(driverId: string) {
    const now = new Date();
    const rows = await this.db.client.scheduledRide.findMany({
      where: {
        OR: [
          { driverId, status: { in: ['SCHEDULED', 'OFFERED', 'ACCEPTED'] } },
          { driverId: null, status: { in: ['SCHEDULED', 'OFFERED'] } },
        ],
        scheduledFor: { gte: now },
      },
      include: {
        request: {
          select: {
            id: true,
            pickupAddress: true,
            dropAddress: true,
            pickupLat: true,
            pickupLng: true,
            dropLat: true,
            dropLng: true,
            quotedFare: true,
            vehicleTypeId: true,
          },
        },
      },
      orderBy: { scheduledFor: 'asc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      customerId: row.customerId,
      driverId: row.driverId,
      scheduledFor: row.scheduledFor.toISOString(),
      status: row.status,
      reminderSentAt: row.reminderSentAt?.toISOString() ?? null,
      rideId: row.rideId,
      pickupAddress: row.request.pickupAddress,
      dropAddress: row.request.dropAddress,
      pickupLat: Number(row.request.pickupLat),
      pickupLng: Number(row.request.pickupLng),
      dropLat: row.request.dropLat != null ? Number(row.request.dropLat) : null,
      dropLng: row.request.dropLng != null ? Number(row.request.dropLng) : null,
      quotedFare: row.request.quotedFare != null ? Number(row.request.quotedFare) : null,
      vehicleTypeId: row.request.vehicleTypeId,
    }));
  }

  async accept(scheduledId: string, driverId: string) {
    return this.db.client.$transaction(async (tx) => {
      const row = await tx.scheduledRide.findUnique({ where: { id: scheduledId } });
      if (!row) throw new ScheduledRideNotFoundError(scheduledId);
      if (!['SCHEDULED', 'OFFERED'].includes(row.status)) {
        throw new ScheduledRideConflictError(
          `Cannot accept scheduled ride in status ${row.status}`,
        );
      }
      if (row.driverId && row.driverId !== driverId) {
        throw new ScheduledRideConflictError('Scheduled ride is assigned to another driver');
      }
      const updated = await tx.scheduledRide.update({
        where: { id: scheduledId },
        data: { driverId, status: 'ACCEPTED' },
      });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.SCHEDULED_ACCEPTED, scheduledId, {
          scheduledRideId: scheduledId,
          driverId,
          customerId: row.customerId,
          scheduledFor: row.scheduledFor.toISOString(),
        }),
        tx,
      );
      return {
        id: updated.id,
        status: updated.status,
        driverId: updated.driverId,
        scheduledFor: updated.scheduledFor.toISOString(),
      };
    });
  }

  async decline(scheduledId: string, driverId: string) {
    return this.db.client.$transaction(async (tx) => {
      const row = await tx.scheduledRide.findUnique({ where: { id: scheduledId } });
      if (!row) throw new ScheduledRideNotFoundError(scheduledId);
      if (row.driverId && row.driverId !== driverId) {
        throw new ScheduledRideConflictError('Scheduled ride is assigned to another driver');
      }
      if (!['SCHEDULED', 'OFFERED', 'ACCEPTED'].includes(row.status)) {
        throw new ScheduledRideConflictError(
          `Cannot decline scheduled ride in status ${row.status}`,
        );
      }
      const updated = await tx.scheduledRide.update({
        where: { id: scheduledId },
        data: {
          status: 'DECLINED',
          driverId: null,
        },
      });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.SCHEDULED_DECLINED, scheduledId, {
          scheduledRideId: scheduledId,
          driverId,
          customerId: row.customerId,
        }),
        tx,
      );
      return { id: updated.id, status: updated.status };
    });
  }

  /// T-30min reminder sweep. Marks rows and returns payloads for socket emit.
  async claimDueReminders(
    now = new Date(),
    limit = 100,
    tx?: TransactionClient,
  ): Promise<
    Array<{
      id: string;
      driverId: string | null;
      customerId: string;
      scheduledFor: Date;
    }>
  > {
    const client = tx ?? this.db.client;
    const windowEnd = new Date(now.getTime() + 30 * 60 * 1000);
    const due = await client.scheduledRide.findMany({
      where: {
        status: 'ACCEPTED',
        reminderSentAt: null,
        scheduledFor: { gt: now, lte: windowEnd },
        driverId: { not: null },
      },
      take: limit,
      orderBy: { scheduledFor: 'asc' },
    });
    const claimed: Array<{
      id: string;
      driverId: string | null;
      customerId: string;
      scheduledFor: Date;
    }> = [];
    for (const row of due) {
      const { count } = await client.scheduledRide.updateMany({
        where: { id: row.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (count === 1) {
        claimed.push({
          id: row.id,
          driverId: row.driverId,
          customerId: row.customerId,
          scheduledFor: row.scheduledFor,
        });
      }
    }
    return claimed;
  }
}
