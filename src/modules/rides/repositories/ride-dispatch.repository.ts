import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RideDispatch, RideRequest, DispatchResponse } from '../types';
export class RideDispatchRepository {
  constructor(private readonly db: DatabaseService) {}
  async createOffer(
    data: {
      requestId: string;
      driverId: string;
      vehicleId?: string | null;
      driverDistanceM?: number | null;
      driverEtaSeconds?: number | null;
      dispatchRound?: number;
      expiresAt?: Date | null;
    },
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.create({
      data: {
        requestId: data.requestId,
        driverId: data.driverId,
        dispatchRound: data.dispatchRound ?? 1,
        response: 'PENDING',
        ...(data.vehicleId !== undefined ? { vehicleId: data.vehicleId } : {}),
        ...(data.driverDistanceM !== undefined ? { driverDistanceM: data.driverDistanceM } : {}),
        ...(data.driverEtaSeconds !== undefined ? { driverEtaSeconds: data.driverEtaSeconds } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      },
    });
  }
  async findByRequestAndDriver(
    requestId: string,
    driverId: string,
    tx?: TransactionClient,
  ): Promise<RideDispatch | null> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.findUnique({
      where: {
        requestId_driverId: { requestId, driverId },
      },
    });
  }
  async updateResponse(
    id: string,
    response: DispatchResponse,
    rejectReason?: string,
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.update({
      where: { id },
      data: {
        response,
        respondedAt: new Date(),
        ...(rejectReason !== undefined ? { rejectReason } : {}),
      },
    });
  }
  async findPendingForDriver(
    driverId: string,
    tx?: TransactionClient,
  ): Promise<(RideDispatch & { request: RideRequest })[]> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.findMany({
      where: {
        driverId,
        response: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        // The offer row is not the whole truth about whether it is worth
        // showing. A dispatch round can commit an offer moments before another
        // driver's accept claims the request, and `resolveOffers` only closes
        // the offers that existed when it ran — so a PENDING row can outlive its
        // request. Filtering on the request's own status stops the driver app
        // rendering an offer whose only possible outcome is
        // RIDE_REQUEST_ALREADY_MATCHED.
        request: { status: { in: ['CREATED', 'SEARCHING'] } },
      },
      include: { request: true },
      orderBy: { offeredAt: 'desc' },
    });
  }
  /// Called the moment one driver's accept wins the request (see
  /// `LifecycleService.acceptRideRequest`). Marks that driver's own pending
  /// offer ACCEPTED and every other driver's pending offer for the same
  /// request CANCELLED, so `findPendingForDriver` stops surfacing an offer
  /// for a ride that is already gone the instant it's gone — not 30 seconds
  /// later when `DispatchTimeoutJob` would otherwise age it out.
  async resolveOffers(
    requestId: string,
    winningDriverId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.db.client;
    const respondedAt = new Date();
    await client.rideDispatch.updateMany({
      where: { requestId, driverId: winningDriverId, response: 'PENDING' },
      data: { response: 'ACCEPTED', respondedAt },
    });
    await client.rideDispatch.updateMany({
      where: { requestId, driverId: { not: winningDriverId }, response: 'PENDING' },
      data: { response: 'CANCELLED', respondedAt },
    });
  }
  async cancelAllPendingForRequest(requestId: string, tx?: TransactionClient): Promise<void> {
    const client = tx ?? this.db.client;
    await client.rideDispatch.updateMany({
      where: { requestId, response: 'PENDING' },
      data: { response: 'CANCELLED', respondedAt: new Date() },
    });
  }
  async findAllDriverIdsForRequest(requestId: string, tx?: TransactionClient): Promise<string[]> {
    const client = tx ?? this.db.client;
    const rows = await client.rideDispatch.findMany({
      where: { requestId },
      select: { driverId: true },
    });
    return rows.map((row) => row.driverId);
  }
  /// Locks one offer row for the duration of the caller's transaction. Reject
  /// and accept both go through this so two responses to the same offer — or a
  /// response racing the timeout job — serialise instead of interleaving.
  async lockForUpdate(id: string, tx: TransactionClient): Promise<RideDispatch | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ride_dispatches" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.rideDispatch.findUnique({ where: { id } });
  }
  /// The offer a driver is acting on when they accept: theirs, for this
  /// request, still PENDING, still inside its window. Row-locked because the
  /// caller is about to decide a race on it.
  async lockActionableOffer(
    requestId: string,
    driverId: string,
    tx: TransactionClient,
  ): Promise<RideDispatch | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ride_dispatches"
       WHERE "request_id" = ${requestId}::uuid AND "driver_id" = ${driverId}::uuid
       FOR UPDATE
    `;
    const id = locked[0]?.id;
    if (!id) return null;
    return tx.rideDispatch.findUnique({ where: { id } });
  }
  /// Conditional transition out of PENDING. Returns false when somebody else
  /// already moved the row — the caller turns that into the right error rather
  /// than overwriting a decision that has already been made.
  async respondIfPending(
    id: string,
    response: DispatchResponse,
    rejectReason?: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.rideDispatch.updateMany({
      where: { id, response: 'PENDING' },
      data: {
        response,
        respondedAt: new Date(),
        ...(rejectReason !== undefined ? { rejectReason } : {}),
      },
    });
    return count === 1;
  }
  async findExpiredPending(
    now: Date,
    limit: number,
    tx?: TransactionClient,
  ): Promise<RideDispatch[]> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.findMany({
      where: { response: 'PENDING', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }
  /// Offers still in front of a driver right now: PENDING and inside their
  /// window. What a dispatch round tops up towards the batch size, so a run of
  /// rejections cannot stack round on round until half the city holds an offer.
  async countLiveOffers(requestId: string, tx?: TransactionClient): Promise<number> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.count({
      where: {
        requestId,
        response: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
  }
  async highestRound(requestId: string, tx?: TransactionClient): Promise<number> {
    const client = tx ?? this.db.client;
    const row = await client.rideDispatch.findFirst({
      where: { requestId },
      orderBy: { dispatchRound: 'desc' },
      select: { dispatchRound: true },
    });
    return row?.dispatchRound ?? 0;
  }
}
