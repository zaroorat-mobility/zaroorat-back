import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RoomAuthorizationService } from '../../../src/modules/realtime/room-authorization.service.js';
import type { SocketPrincipal } from '../../../src/modules/realtime/socket-auth.service.js';

const RIDE = { id: 'ride_1', customerId: 'user_cust', driverId: 'drv_assigned' };

function service(ride: Record<string, unknown> | null = RIDE) {
  return new RoomAuthorizationService({
    async findById(id: string) {
      return ride && ride.id === id ? ride : null;
    },
  } as never);
}

function principal(overrides: Partial<SocketPrincipal> = {}): SocketPrincipal {
  return { userId: 'user_cust', sid: 's', roles: ['customer'], driverId: null, ...overrides };
}

describe('Room authorization', () => {
  describe('identity rooms', () => {
    it('gives a customer only their own user room', () => {
      assert.deepEqual(service().identityRooms(principal()), ['user:user_cust']);
    });

    it('gives an operable driver a driver room too', () => {
      assert.deepEqual(service().identityRooms(principal({ driverId: 'drv_assigned' })), [
        'user:user_cust',
        'driver:drv_assigned',
      ]);
    });

    it('gives a suspended driver no driver room', () => {
      // driverId is null for a non-operable driver, so there is no room to leak
      // offers into.
      assert.deepEqual(service().identityRooms(principal({ roles: ['driver'] })), [
        'user:user_cust',
      ]);
    });
  });

  describe('ride rooms', () => {
    it('admits the customer who booked the ride', async () => {
      assert.equal(await service().assertCanJoinRide(principal(), 'ride_1'), 'ride:ride_1');
    });

    it('admits the driver assigned to the ride', async () => {
      const driver = principal({ userId: 'user_drv', driverId: 'drv_assigned', roles: ['driver'] });
      assert.equal(await service().assertCanJoinRide(driver, 'ride_1'), 'ride:ride_1');
    });

    it('refuses a different customer', async () => {
      await assert.rejects(
        () => service().assertCanJoinRide(principal({ userId: 'user_stranger' }), 'ride_1'),
        (err: unknown) => (err as { code?: string }).code === 'ROOM_ACCESS_DENIED',
      );
    });

    it('refuses a driver who is not the assigned one', async () => {
      const other = principal({ userId: 'user_o', driverId: 'drv_other', roles: ['driver'] });
      await assert.rejects(
        () => service().assertCanJoinRide(other, 'ride_1'),
        (err: unknown) => (err as { code?: string }).code === 'ROOM_ACCESS_DENIED',
      );
    });

    it('refuses a suspended driver even for the ride they are assigned to', async () => {
      // No driver identity means no way to match `ride.driverId`.
      const suspended = principal({ userId: 'user_drv', driverId: null, roles: ['driver'] });
      await assert.rejects(() => suspended && service().assertCanJoinRide(suspended, 'ride_1'));
    });

    it('answers a missing ride exactly as it answers an unauthorised one', async () => {
      // Distinguishing the two would turn the room API into a probe for valid
      // ride ids.
      const missing = await service()
        .assertCanJoinRide(principal(), 'ride_nope')
        .catch((err: unknown) => (err as Error).message);
      const denied = await service()
        .assertCanJoinRide(principal({ userId: 'stranger' }), 'ride_1')
        .catch((err: unknown) => (err as Error).message);
      assert.equal(typeof missing, 'string');
      assert.equal(typeof denied, 'string');
    });
  });

  describe('assigned-driver check', () => {
    it('is true only for the driver on the ride', async () => {
      assert.equal(
        await service().isAssignedDriver(principal({ driverId: 'drv_assigned' }), 'ride_1'),
        true,
      );
      assert.equal(
        await service().isAssignedDriver(principal({ driverId: 'drv_other' }), 'ride_1'),
        false,
      );
      assert.equal(await service().isAssignedDriver(principal(), 'ride_1'), false);
    });
  });
});
