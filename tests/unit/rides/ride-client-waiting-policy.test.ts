import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimatedDriverEarning,
  toClientOfferView,
  toClientRideView,
} from '../../../src/modules/rides/presenters/ride-client.presenter.js';

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

describe('what the driver sees about the rider and the money', () => {
  const customer = (aggregate: unknown) => ({
    id: 'u-1',
    profile: {},
    customerRatingAggregate: aggregate,
  });

  it('shows the real average once the rider has been rated', () => {
    const view = toClientRideView({
      ...ride(null),
      customer: customer({ avgRating: '4.60', totalRatings: 12 }),
    } as never);
    const shown = view?.customer as { rating: number | null; totalRatings: number };
    assert.equal(shown.rating, 4.6);
    assert.equal(shown.totalRatings, 12);
  });

  it('treats an unrated rider as new, not as rated zero', () => {
    const empty = toClientRideView({
      ...ride(null),
      customer: customer({ avgRating: 0, totalRatings: 0 }),
    } as never);
    assert.equal((empty?.customer as { rating: unknown }).rating, null);
    const noRow = toClientRideView({ ...ride(null), customer: customer(null) } as never);
    assert.equal((noRow?.customer as { rating: unknown }).rating, null);
  });

  it('exposes the commission fixed at acceptance', () => {
    const view = toClientRideView({ ...ride(null), commissionAmount: '18.50' } as never);
    assert.equal(view?.commissionAmount, 18.5);
  });

  it('carries the rating and earning estimate on an offer', () => {
    const offer = toClientOfferView(
      { id: 'd-1', request: { customerId: 'u-1' } } as never,
      new Map([['u-1', { firstName: 'A', lastName: null, avgRating: 4.2, totalRatings: 3 }]]),
      88,
    );
    assert.equal(offer.estimatedDriverEarning, 88);
    const rider = (offer.request as { customer: { rating: number } }).customer;
    assert.equal(rider.rating, 4.2);
  });

  it('estimates earning on the same split the ledger applies', () => {
    const quote = { driverEarning: 80, platformCommission: 20 };
    assert.equal(estimatedDriverEarning(quote, 5, 'COMMISSION'), 85);
    assert.equal(estimatedDriverEarning(quote, 5, 'SUBSCRIPTION'), 105);
    assert.equal(estimatedDriverEarning(quote, 0, null), 80);
  });
});
