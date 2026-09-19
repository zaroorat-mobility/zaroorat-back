import { DatabaseService } from '@core/database';
import { RideError } from '../../errors/ride.errors.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import type { CallProvider, CallInitiationResult } from './call.provider.js';

export class RideCallService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rideRepository: RideRepository,
    private readonly callProvider: CallProvider,
  ) {}

  async initiate(rideId: string, callerUserId: string): Promise<CallInitiationResult> {
    const ride = await this.rideRepository.findById(rideId);
    if (!ride) throw new RideError(`Ride '${rideId}' was not found`, 'RIDE_NOT_FOUND', 404);

    const active = ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(
      ride.status,
    );
    if (!active) {
      throw new RideError(
        'Calling is only available during an active ride',
        'CALL_NOT_ALLOWED',
        409,
      );
    }

    const driver = await this.db.client.driver.findUnique({
      where: { id: ride.driverId },
      select: { userId: true },
    });
    if (!driver) throw new RideError('Driver not found for ride', 'RIDE_NOT_FOUND', 404);

    const isCustomer = ride.customerId === callerUserId;
    const isDriver = driver.userId === callerUserId;
    if (!isCustomer && !isDriver) {
      throw new RideError('You are not a party to this ride', 'CALL_FORBIDDEN', 403);
    }

    const counterpartyUserId = isDriver ? ride.customerId : driver.userId;
    const counterparty = await this.db.client.user.findUnique({
      where: { id: counterpartyUserId },
      select: { phoneNumber: true },
    });
    if (!counterparty?.phoneNumber) {
      throw new RideError('Counterparty phone is unavailable', 'CALL_UNAVAILABLE', 404);
    }

    return this.callProvider.initiate({
      rideId,
      callerUserId,
      callerRole: isDriver ? 'DRIVER' : 'CUSTOMER',
      counterpartyUserId,
      counterpartyPhone: counterparty.phoneNumber,
    });
  }
}
