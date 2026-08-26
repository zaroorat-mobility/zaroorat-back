import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RatingService } from '../../../src/modules/rating/services/rating.service.js';
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
    driverId: 'driver_1',
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
    /// The real query averages a driver's CUSTOMER ratings; this mirrors it over
    /// the fake store so the service's aggregate step is exercised rather than
    /// stubbed away.
    async averageForDriver() {
      const stars = ratings.filter((r) => r.ratedBy === 'CUSTOMER').map((r) => r.rating as number);
      if (stars.length === 0) return null;
      return stars.reduce((sum, star) => sum + star, 0) / stars.length;
    },
  };
  const driverRatings: { driverId: string; rating: number }[] = [];
  const driverRepository = {
    async setRating(driverId: string, rating: number) {
      driverRatings.push({ driverId, rating });
      return { id: driverId, rating };
    },
  };
  const txManager = {
    async execute<T>(fn: (tx: unknown) => Promise<T>) {
      return fn({});
    },
  };
  const service = new RatingService(
    rideRepo as never,
    ratingRepo as never,
    driverRepository as never,
    txManager as never,
  );
  return { service, ratings, driverRatings };
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

  it("moves the driver's stored average, rounded to two places", async () => {
    const world = makeWorld();
    await world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 4);

    assert.deepEqual(world.driverRatings, [{ driverId: 'driver_1', rating: 4 }]);
  });

  it('averages every customer rating a driver has, not just the latest', async () => {
    const world = makeWorld();
    // An earlier rated ride for the same driver, already on record.
    world.ratings.push({ rideId: 'ride_0', ratedBy: 'CUSTOMER', rating: 2 });

    await world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 4);

    // (2 + 4) / 2 — the stored score is the mean of every rating, not the last
    // one in. Storing only the newest was the other obvious way to write this
    // and it would let one good ride erase a bad history.
    assert.equal(world.driverRatings.at(-1)?.rating, 3);
  });

  it('rounds a repeating average to two decimal places, as the column stores', async () => {
    const world = makeWorld();
    world.ratings.push({ rideId: 'ride_0', ratedBy: 'CUSTOMER', rating: 4 });
    world.ratings.push({ rideId: 'ride_2', ratedBy: 'CUSTOMER', rating: 5 });

    await world.service.submitRating('ride_1', 'CUSTOMER', 'cust_1', 5);

    // (4 + 5 + 5) / 3 = 4.666… into a Decimal(3,2).
    assert.equal(world.driverRatings.at(-1)?.rating, 4.67);
  });

  it("does not touch the driver's score when the driver rates the customer", async () => {
    const world = makeWorld();
    await world.service.submitRating('ride_1', 'DRIVER', 'driver_user_1', 1);

    // There is no customer rating column anywhere in the schema, so this half is
    // still write-only — but it must never be misfiled onto the driver.
    assert.deepEqual(world.driverRatings, []);
  });
});
