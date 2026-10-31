import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toClientRideView } from '../../../src/modules/rides/presenters/ride-client.presenter.js';

function ride(pricingRule: unknown) {
  return {
    id: 'ride-1',
    status: 'DRIVER_ARRIVED',
    request: { pickupLat: 12.97, pickupLng: 77.59, dropLat: 12.98, dropLng: 77.6, pricingRule },
  };
}

describe('client ride view waiting policy', () => {
  it("exposes the booked rule's free minutes and per-minute rate", () => {
    const view = toClientRideView(ride({ freeWaitingMin: 3, waitingPerMin: '1.50' }) as never);
    assert.deepEqual(view?.waitingPolicy, { freeMinutes: 3, perMinute: 1.5 });
  });

  it('is null for a request booked without a pricing rule', () => {
    assert.equal(toClientRideView(ride(null) as never)?.waitingPolicy, null);
  });

  it('does not repeat the raw rule inside the request block', () => {
    const view = toClientRideView(ride({ freeWaitingMin: 3, waitingPerMin: 1 }) as never);
    const json = JSON.parse(JSON.stringify(view));
    assert.equal('pricingRule' in json.request, false);
  });
});
