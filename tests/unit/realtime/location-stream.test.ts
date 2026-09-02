import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LocationStreamService } from '../../../src/modules/realtime/location-stream.service.js';
import { realtimeConfig } from '../../../src/config/realtime/realtime.config.js';
import type { SocketPrincipal } from '../../../src/modules/realtime/socket-auth.service.js';

const DRIVER: SocketPrincipal = {
  userId: 'user_drv',
  sid: 's',
  roles: ['driver'],
  driverId: 'drv_1',
};
const CUSTOMER: SocketPrincipal = {
  userId: 'user_c',
  sid: 's',
  roles: ['customer'],
  driverId: null,
};
const FRAME = { latitude: 12.9716, longitude: 77.5946 };

function makeService() {
  const writes: Record<string, unknown>[] = [];
  const service = new LocationStreamService(
    {
      async updateLocation(input: Record<string, unknown>) {
        writes.push(input);
        return input;
      },
    } as never,
    { findActiveByDriver: async () => null } as never,
    { recordPoint: async () => false } as never,
    { refreshEta: async () => null, forget: () => {} } as never,
  );
  return { service, writes };
}

describe('Driver location streaming', () => {
  describe('who may publish', () => {
    it('refuses a customer', async () => {
      const { service, writes } = makeService();
      await assert.rejects(
        () => service.accept(CUSTOMER, FRAME),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_FORBIDDEN',
      );
      assert.deepEqual(writes, [], 'nothing may be written for an unauthorised publisher');
    });

    it('refuses a driver with no operable identity', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.accept({ ...DRIVER, driverId: null }, FRAME),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_FORBIDDEN',
      );
    });

    it('accepts an operable driver', async () => {
      const { service, writes } = makeService();
      const accepted = await service.accept(DRIVER, FRAME);
      assert.equal(accepted.envelope.type, 'ride.driver.location');
      assert.equal(accepted.envelope.data.driverId, 'drv_1');
      assert.equal(accepted.persisted, true, 'the first frame is always written through');
      assert.equal(writes.length, 1);
    });
  });

  describe('payload validation', () => {
    const malformed: [string, unknown][] = [
      ['a latitude out of range', { latitude: 999, longitude: 77 }],
      ['a longitude out of range', { latitude: 12, longitude: 999 }],
      ['a missing coordinate', { latitude: 12 }],
      ['a string coordinate', { latitude: '12', longitude: '77' }],
      ['a negative speed', { ...FRAME, speedKmh: -5 }],
      ['a heading beyond a circle', { ...FRAME, heading: 400 }],
      ['null', null],
      ['a bare string', 'nonsense'],
      ['an array', [1, 2]],
    ];

    for (const [label, payload] of malformed) {
      it(`rejects ${label} safely`, async () => {
        const { service, writes } = makeService();
        await assert.rejects(
          () => service.accept(DRIVER, payload),
          (err: unknown) => (err as { code?: string }).code === 'INVALID_SOCKET_PAYLOAD',
        );
        assert.deepEqual(writes, []);
      });
    }

    it('ignores a rideId the client tries to attach', async () => {
      // Which ride a frame belongs to is decided by room membership, never by
      // the payload — the schema strips it.
      const { service } = makeService();
      const accepted = await service.accept(DRIVER, { ...FRAME, rideId: 'ride_someone_else' });
      assert.equal(accepted.envelope.data.rideId, undefined);
    });
  });

  describe('backpressure', () => {
    it('drops a frame arriving inside the minimum interval', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      await assert.rejects(
        () => service.accept(DRIVER, FRAME, now + realtimeConfig.locationMinIntervalMs - 1),
        (err: unknown) => (err as { code?: string }).code === 'LOCATION_RATE_LIMITED',
      );
    });

    it('accepts again once the interval has passed', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      const later = await service.accept(DRIVER, FRAME, now + realtimeConfig.locationMinIntervalMs);
      assert.ok(later.envelope);
    });

    it('rate-limits per driver, not globally', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      const other = await service.accept({ ...DRIVER, driverId: 'drv_2' }, FRAME, now);
      assert.ok(other.envelope, 'one busy driver must not throttle another');
    });
  });

  describe('staleness and ordering', () => {
    it('refuses a frame older than the maximum age', async () => {
      const { service } = makeService();
      const now = Date.now();
      const recordedAt = new Date(now - realtimeConfig.locationMaxAgeMs - 1).toISOString();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt }, now),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses a frame from the future', async () => {
      const { service } = makeService();
      const now = Date.now();
      const recordedAt = new Date(now + realtimeConfig.locationMaxAgeMs + 5_000).toISOString();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt }, now),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses an out-of-order frame replayed after a newer one', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, { ...FRAME, recordedAt: new Date(now).toISOString() }, now);
      const older = new Date(now - 5_000).toISOString();
      await assert.rejects(
        () =>
          service.accept(
            DRIVER,
            { ...FRAME, recordedAt: older },
            now + realtimeConfig.locationMinIntervalMs,
          ),
        (err: unknown) => (err as { code?: string }).code === 'STALE_LOCATION',
      );
    });

    it('refuses an unparseable timestamp', async () => {
      const { service } = makeService();
      await assert.rejects(
        () => service.accept(DRIVER, { ...FRAME, recordedAt: 'not-a-date' }),
        (err: unknown) => (err as { code?: string }).code === 'INVALID_SOCKET_PAYLOAD',
      );
    });
  });

  describe('storage sampling', () => {
    it('broadcasts every accepted frame but writes only on the sampling interval', async () => {
      const { service, writes } = makeService();
      const start = Date.now();
      let broadcasts = 0;

      // One frame per minimum interval, across two sampling windows.
      const step = realtimeConfig.locationMinIntervalMs;
      const span = realtimeConfig.locationPersistIntervalMs * 2;
      for (let elapsed = 0; elapsed <= span; elapsed += step) {
        const accepted = await service.accept(DRIVER, FRAME, start + elapsed);
        if (accepted.envelope) broadcasts++;
      }

      assert.ok(broadcasts > writes.length, 'far more frames broadcast than written');
      const expectedWrites = Math.floor(span / realtimeConfig.locationPersistIntervalMs) + 1;
      assert.equal(writes.length, expectedWrites, 'exactly one write per sampling window');
    });

    it('forgets a driver on disconnect so state cannot grow without bound', async () => {
      const { service } = makeService();
      const now = Date.now();
      await service.accept(DRIVER, FRAME, now);
      service.forget('drv_1');
      // A fresh frame at the same instant is accepted again — the throttle state
      // really was dropped.
      const again = await service.accept(DRIVER, FRAME, now);
      assert.equal(again.persisted, true);
    });
  });
});
