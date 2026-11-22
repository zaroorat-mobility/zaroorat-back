import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { RideEtaService } from '../../../src/modules/location/services/ride-eta.service.js';

const DRIVER = { latitude: 12.97, longitude: 77.59 };
const DEST = { latitude: 12.99, longitude: 77.61 };
const ROUTE = { distanceMeters: 4000, durationSeconds: 600, providerName: 'google' };

describe('RideEtaService cache', () => {
  afterEach(() => mock.restoreAll());

  it('drops entries idle for 10 minutes, so finished rides do not accumulate', async () => {
    let now = 1_000_000_000;
    mock.method(Date, 'now', () => now);
    let failing = false;
    const service = new RideEtaService({
      async getDirections() {
        if (failing) throw new Error('provider down');
        return ROUTE;
      },
    } as never);

    const first = await service.refreshEta({
      rideId: 'r1',
      driverPosition: DRIVER,
      destination: DEST,
    });
    assert.equal(first?.stale, false);

    // A cached ride survives a provider failure as a stale snapshot...
    failing = true;
    now += 60_000;
    const stale = await service.refreshEta({
      rideId: 'r1',
      driverPosition: DRIVER,
      destination: DEST,
    });
    assert.equal(stale?.stale, true);

    // ...but once idle past the window it is gone: another ride's refresh sweeps it.
    failing = false;
    now += 10 * 60_000;
    await service.refreshEta({ rideId: 'r2', driverPosition: DRIVER, destination: DEST });
    failing = true;
    const evicted = await service.refreshEta({
      rideId: 'r1',
      driverPosition: DRIVER,
      destination: DEST,
    });
    assert.equal(evicted, null);
  });
});

describe('RideEtaService refresh policy', () => {
  afterEach(() => mock.restoreAll());

  /// ~0.0009° of latitude is ~100 m; 0.002° is ~220 m.
  const north = (meters: number) => ({
    latitude: DRIVER.latitude + meters / 111_000,
    longitude: DRIVER.longitude,
  });

  function harness() {
    let now = 2_000_000_000;
    mock.method(Date, 'now', () => now);
    let calls = 0;
    const service = new RideEtaService({
      async getDirections() {
        calls += 1;
        return ROUTE;
      },
    } as never);
    return {
      service,
      advance: (ms: number) => {
        now += ms;
      },
      calls: () => calls,
    };
  }

  it('does not call the provider again for movement alone inside the minimum interval', async () => {
    const h = harness();
    await h.service.refreshEta({ rideId: 'r', driverPosition: DRIVER, destination: DEST });

    h.advance(10_000);
    const cached = await h.service.refreshEta({
      rideId: 'r',
      driverPosition: north(500),
      destination: DEST,
    });

    assert.equal(h.calls(), 1);
    assert.equal(cached?.stale, true);
  });

  it('recomputes once the interval has passed and the driver has moved', async () => {
    const h = harness();
    await h.service.refreshEta({ rideId: 'r', driverPosition: DRIVER, destination: DEST });

    h.advance(30_000);
    const fresh = await h.service.refreshEta({
      rideId: 'r',
      driverPosition: north(220),
      destination: DEST,
    });

    assert.equal(h.calls(), 2);
    assert.equal(fresh?.stale, false);
  });

  it('re-checks a stationary driver only after the maximum interval', async () => {
    const h = harness();
    await h.service.refreshEta({ rideId: 'r', driverPosition: DRIVER, destination: DEST });

    h.advance(60_000);
    await h.service.refreshEta({ rideId: 'r', driverPosition: DRIVER, destination: DEST });
    assert.equal(h.calls(), 1, 'not moved, not yet at the maximum interval');

    h.advance(60_000);
    const fresh = await h.service.refreshEta({
      rideId: 'r',
      driverPosition: DRIVER,
      destination: DEST,
    });
    assert.equal(h.calls(), 2);
    assert.equal(fresh?.stale, false);
  });

  it('recomputes immediately when the target switches from pickup to drop', async () => {
    const h = harness();
    await h.service.refreshEta({
      rideId: 'r',
      driverPosition: DRIVER,
      destination: DEST,
      destinationType: 'PICKUP',
    });

    h.advance(1_000);
    const drop = await h.service.refreshEta({
      rideId: 'r',
      driverPosition: DRIVER,
      destination: DEST,
      destinationType: 'DROP',
    });

    assert.equal(h.calls(), 2);
    assert.equal(drop?.destinationType, 'DROP');
    assert.equal(drop?.stale, false);
  });

  it('bounds provider calls for a driver streaming a fix every 2 s at 36 km/h', async () => {
    const h = harness();
    // 10 minutes of fixes, 20 m apart. Movement alone used to trigger a call
    // every 100 m, i.e. every 10 s (61 calls); now it is one per 30 s.
    for (let i = 0; i <= 300; i++) {
      await h.service.refreshEta({
        rideId: 'r',
        driverPosition: north(i * 20),
        destination: DEST,
      });
      h.advance(2_000);
    }

    assert.equal(h.calls(), 21);
  });
});
