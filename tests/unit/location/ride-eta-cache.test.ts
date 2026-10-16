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
