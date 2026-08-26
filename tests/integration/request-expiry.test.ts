import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { makeVehicleType } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { RequestExpiryJob } from '../../src/modules/rides/jobs/request-expiry.job.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

/// A request nobody accepts is the one terminal outcome the platform used to
/// keep to itself. The job flipped the row to EXPIRED and published nothing, so
/// no push and no socket message existed for it and the rider's app stayed on
/// "searching for a driver" indefinitely.
describe('a ride request that finds no driver (H-3)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  function runJob(): Promise<number> {
    return container.resolve<RequestExpiryJob>('requestExpiryJob').run();
  }

  async function bookedRequest(phone: string): Promise<{ requestId: string; rider: LoggedInUser }> {
    const vehicleTypeId = await makeVehicleType({ code: `EXP_${randomUUID().slice(0, 6)}` });
    const rider = await loginAs(app, phone);
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: rider.authHeader,
      payload: { firstName: 'Cat', lastName: 'Customer' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: rider.authHeader,
      payload: { vehicleTypeId, ...TRIP },
    });
    assert.equal(created.statusCode, 200, created.payload);
    return { requestId: created.json().data.id as string, rider };
  }

  /// Drags the window shut rather than waiting out `RIDE_REQUEST_EXPIRY_MIN`.
  async function ageOut(requestId: string): Promise<void> {
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
  }

  /// The outbox rows announcing an expiry, with their envelope data unwrapped.
  /// `payload` holds the whole envelope, so the domain fields are one level in.
  async function expiryEvents(): Promise<Record<string, unknown>[]> {
    const rows = await db().client.outboxEvent.findMany({
      where: { eventType: 'ride.request.expired' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => (row.payload as { data?: Record<string, unknown> }).data ?? {});
  }

  it('expires the request and announces it, in one transaction', async () => {
    const { requestId, rider } = await bookedRequest('+919876750001');
    await ageOut(requestId);

    assert.equal(await runJob(), 1);

    const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.equal(request.status, 'EXPIRED');

    const events = await expiryEvents();
    assert.equal(events.length, 1, 'the rider must be told exactly once');
    assert.equal(events[0]!.requestId, requestId);
    // Addressed by customer, not by ride: there is no ride and never will be.
    assert.equal(events[0]!.customerId, rider.userId);
  });

  it('leaves a request still inside its window alone, and says nothing', async () => {
    const { requestId } = await bookedRequest('+919876750002');

    assert.equal(await runJob(), 0);

    const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.notEqual(request.status, 'EXPIRED');
    assert.equal((await expiryEvents()).length, 0);
  });

  /// Covers the sweep's read filter, not the conditional claim behind it: the
  /// request is already MATCHED before the job runs, so `findMany` never returns
  /// it. The claim guards the narrower case where a driver accepts *between* that
  /// read and the write, which needs an interleaving this test cannot stage —
  /// see the note in `RequestExpiryJob.expire`.
  it('never expires a request a driver has already taken, and never tells that rider it failed', async () => {
    const { requestId } = await bookedRequest('+919876750003');
    await ageOut(requestId);
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { status: 'MATCHED' },
    });

    assert.equal(await runJob(), 0);

    const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.equal(request.status, 'MATCHED', 'a matched request must survive the sweep');
    assert.equal((await expiryEvents()).length, 0);
  });

  it('announces once however often the job runs', async () => {
    const { requestId } = await bookedRequest('+919876750004');
    await ageOut(requestId);

    assert.equal(await runJob(), 1);
    assert.equal(await runJob(), 0, 'an already-expired request is not expired again');
    assert.equal(await runJob(), 0);

    assert.equal((await expiryEvents()).length, 1);
  });
});
