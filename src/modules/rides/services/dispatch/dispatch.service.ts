import { RideDispatchRepository } from '../../repositories/ride-dispatch.repository.js';
import { EventPublisher } from '@core/events';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';
import type { RideDispatch } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';

export class DispatchService {
  constructor(
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly rideMetrics: RideMetrics,
  ) {}

  async offerToDriver(
    data: {
      requestId: string;
      driverId: string;
      vehicleId?: string;
      driverDistanceM?: number;
      driverEtaSeconds?: number;
      dispatchRound?: number;
    },
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    const expiresAt = new Date(Date.now() + 30 * 1000);

    const offerParams = {
      requestId: data.requestId,
      driverId: data.driverId,
      dispatchRound: data.dispatchRound ?? 1,
      expiresAt,
      ...(data.vehicleId !== undefined ? { vehicleId: data.vehicleId } : {}),
      ...(data.driverDistanceM !== undefined ? { driverDistanceM: data.driverDistanceM } : {}),
      ...(data.driverEtaSeconds !== undefined ? { driverEtaSeconds: data.driverEtaSeconds } : {}),
    };

    const dispatch = await this.dispatchRepo.createOffer(offerParams, tx);

    this.rideMetrics.dispatchOffered({ requestId: data.requestId, driverId: data.driverId });

    await this.eventPublisher.publish(
      rideEvent(RIDE_EVENT_CATALOG.DISPATCH_OFFERED, data.driverId, {
        dispatchId: dispatch.id,
        requestId: data.requestId,
        driverId: data.driverId,
      }),
      tx,
    );

    return dispatch;
  }
}
