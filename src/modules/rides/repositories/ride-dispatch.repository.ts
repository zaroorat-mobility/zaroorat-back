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
}
