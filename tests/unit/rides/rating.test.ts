import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RatingService } from '../../../src/modules/rides/services/rating/rating.service.js';
import {
  RideCustomerMismatchError,
  RideDriverMismatchError,
  RideNotRatableError,
  AlreadyRatedError,
} from '../../../src/modules/rides/errors/ride.errors.js';

function makeWorld(rideOverrides: Record<string, unknown> = {}) {
  const ratings: Record<string, unknown>[] = [];
  const ride = {
    id: 'ride_1',
    status: 'COMPLETED',
    customerId: 'cust_1',
    driver: { userId: 'driver_user_1' },
    ...rideOverrides,
  };
  const rideRepo = {
    async findById(id: string) {
      return id === ride.id ? ride : null;
    },
  };
  const ratingRepo = {
    async findByRideAndRater(rideId: string, ratedBy: string) {
      return ratings.find((r) => r.rideId === rideId && r.ratedBy === ratedBy) ?? null;
    },
    async create(input: Record<string, unknown>) {
      const record = { id: `rating_${ratings.length + 1}`, ...input };
      ratings.push(record);
      return record;
    },
  };
  const service = new RatingService(rideRepo as never, ratingRepo as never);
  return { service, ratings };
}

describe('RatingService.submitRating', () => {
  it('lets the customer rate the driver on a completed ride', async () => {
    const world = makeWorld();
    const rating = await world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 5, ['polite']);
    assert.equal((rating as { rating: number }).rating, 5);
    assert.equal(world.ratings.length, 1);
  });

  it('lets the driver rate the customer on a completed ride', async () => {
    const world = makeWorld();
    await world.service.submitRating('ride_1', 'DRIVER', 'driver_user_1', 4);
    assert.equal(world.ratings.length, 1);
  });

  it('refuses a customer rating a ride that is not theirs', async () => {
    const world = makeWorld();
    await assert.rejects(
      () => world.service.submitRating('ride_1', 'CUSTOMER', 'someone_else', 5),
      RideCustomerMismatchError,
    );
  });

  it('refuses a driver rating a ride they were not assigned to', async () => {
    const world = makeWorld();
    await assert.rejects(
      () => world.service.submitRating('ride_1', 'DRIVER', 'someone_else', 5),
      RideDriverMismatchError,
    );
  });

  it('refuses rating a ride that has not completed', async () => {
    const world = makeWorld({ status: 'IN_PROGRESS' });
    await assert.rejects(
      () => world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 5),
      RideNotRatableError,
    );
  });

  it('refuses a second rating from the same party', async () => {
    const world = makeWorld();
    await world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 5);
    await assert.rejects(
      () => world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 3),
      AlreadyRatedError,
    );
    assert.equal(world.ratings.length, 1, 'the second attempt did not write a row');
  });
});
