import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  makeActiveSubscription,
  makeAssignedVehicle,
  makeDriver,
  markDriverOnline,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { MatchingService } from '../../src/modules/matching/services/matching.service.js';
import type { VehicleEligibilityService } from '../../src/modules/vehicles/services/vehicle-eligibility.service.js';
import type { StatusService } from '../../src/modules/drivers/services/status/status.service.js';
import type { SubscriptionExpiryJob } from '../../src/modules/subscriptions/jobs/subscription-expiry.job.js';

const HOUR = 60 * 60_000;

/// Dispatch, going online and the expiry sweep all ask the question acceptance
/// answers: can this driver's payment model take a new ride right now?
describe('driver payment eligibility before dispatch (integration)', () => {
  let app: FastifyInstance;
  let phone = 9876546000;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(async () => {
    await resetState();
  });

  async function onlineDriver(
    vehicleTypeId: string,
    model: { paymentModel: 'COMMISSION' | 'SUBSCRIPTION' | null; balance?: number },
  ): Promise<string> {
    phone += 1;
    const user = await loginAs(app, `+91${String(phone)}`);
    const driverId = await makeDriver(user.userId, {
      paymentModel: model.paymentModel,
      ...(model.balance !== undefined ? { commissionWalletBalance: model.balance } : {}),
    });
    await makeAssignedVehicle(driverId, { vehicleTypeId });
    await markDriverOnline(driverId);
    return driverId;
  }

  async function carTypeId(): Promise<string> {
    const car = await db().client.vehicleType.findFirstOrThrow({
      where: { category: 'car', isActive: true },
    });
    return car.id;
  }

  async function statusOf(driverId: string): Promise<string | undefined> {
    const row = await db().client.driverOnlineStatus.findUnique({ where: { driverId } });
    return row?.status;
  }

  describe('dispatch candidates', () => {
    /// Real SQL, real rows; only the geo lookup is stubbed, because geo is not
    /// what decides payment eligibility.
    function matchingOver(driverIds: string[]): MatchingService {
      const geo = {
        findNearbyDrivers: async () => ({
          outcome: 'ok' as const,
          drivers: driverIds.map((driverId, i) => ({ driverId, distanceMeters: 100 + i })),
        }),
      };
      return new MatchingService(
        db(),
        geo as never,
        container.resolve<VehicleEligibilityService>('vehicleEligibilityService'),
      );
    }

    it('offers only drivers whose payment model could accept this ride', async () => {
      const typeId = await carTypeId();
      const subscribed = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(subscribed);
      const lapsed = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      // Expired by server time but not yet swept: still status ACTIVE.
      await makeActiveSubscription(lapsed, { expiresInMs: -60_000 });
      const funded = await onlineDriver(typeId, { paymentModel: 'COMMISSION', balance: 500 });
      const exact = await onlineDriver(typeId, { paymentModel: 'COMMISSION', balance: 50 });
      const short = await onlineDriver(typeId, { paymentModel: 'COMMISSION', balance: 49.99 });
      const noModel = await onlineDriver(typeId, { paymentModel: null });

      const all = [subscribed, lapsed, funded, exact, short, noModel];
      const origin = { latitude: 12.97, longitude: 77.59 };
      const offered = await matchingOver(all).findEligibleCandidates(
        origin,
        [],
        10,
        typeId,
        3000,
        50,
      );

      assert.deepEqual(
        offered.map((c) => c.driverId),
        [subscribed, funded, exact],
      );
    });

    it('leaves the balance to acceptance when the commission could not be priced', async () => {
      const typeId = await carTypeId();
      const short = await onlineDriver(typeId, { paymentModel: 'COMMISSION', balance: 1 });
      const noModel = await onlineDriver(typeId, { paymentModel: null });
      const offered = await matchingOver([short, noModel]).findEligibleCandidates(
        { latitude: 12.97, longitude: 77.59 },
        [],
        10,
        typeId,
        3000,
        undefined,
      );
      assert.deepEqual(
        offered.map((c) => c.driverId),
        [short],
      );
    });
  });

  describe('going online', () => {
    it('refuses a SUBSCRIPTION driver whose plan has expired, and admits one whose plan is live', async () => {
      const typeId = await carTypeId();
      const statusService = container.resolve<StatusService>('statusService');

      const lapsed = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(lapsed, { expiresInMs: -60_000 });
      await db().client.driverOnlineStatus.update({
        where: { driverId: lapsed },
        data: { status: 'OFFLINE' },
      });
      await assert.rejects(statusService.setOnline(lapsed), {
        code: 'DRIVER_SUBSCRIPTION_REQUIRED',
      });
      assert.equal(await statusOf(lapsed), 'OFFLINE');

      const live = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(live);
      await db().client.driverOnlineStatus.update({
        where: { driverId: live },
        data: { status: 'OFFLINE' },
      });
      const status = await statusService.setOnline(live);
      assert.equal(status.status, 'ONLINE');
    });
  });

  describe('subscription expiry sweep', () => {
    it('expires the plan and takes the driver offline, and a second run changes nothing', async () => {
      const typeId = await carTypeId();
      const job = container.resolve<SubscriptionExpiryJob>('subscriptionExpiryJob');
      const driverId = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      const subscriptionId = await makeActiveSubscription(driverId, { expiresInMs: -60_000 });

      assert.equal(await job.run(), 1);
      const subscription = await db().client.driverSubscription.findUniqueOrThrow({
        where: { id: subscriptionId },
      });
      assert.equal(subscription.status, 'EXPIRED');
      assert.equal(await statusOf(driverId), 'OFFLINE');
      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.isAvailable, false);
      assert.equal(driver.paymentModel, 'SUBSCRIPTION');

      assert.equal(await job.run(), 0);
      assert.equal(await statusOf(driverId), 'OFFLINE');
    });

    it('never interrupts a ride: an ON_TRIP driver stays on it and goes offline on a later run', async () => {
      const typeId = await carTypeId();
      const job = container.resolve<SubscriptionExpiryJob>('subscriptionExpiryJob');
      const driverId = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(driverId, { expiresInMs: -60_000 });
      await db().client.driverOnlineStatus.update({
        where: { driverId },
        data: { status: 'ON_TRIP' },
      });

      await job.run();
      assert.equal(await statusOf(driverId), 'ON_TRIP');

      // The ride completes and returns the driver to ONLINE.
      await db().client.driverOnlineStatus.update({
        where: { driverId },
        data: { status: 'ONLINE' },
      });
      await job.run();
      assert.equal(await statusOf(driverId), 'OFFLINE');
    });

    it('applies a staged switch to COMMISSION and leaves that driver online', async () => {
      const typeId = await carTypeId();
      const job = container.resolve<SubscriptionExpiryJob>('subscriptionExpiryJob');
      const driverId = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(driverId, { expiresInMs: -60_000 });
      await db().client.driver.update({
        where: { id: driverId },
        data: { pendingPaymentModel: 'COMMISSION' },
      });

      await job.run();
      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.paymentModel, 'COMMISSION');
      assert.equal(await statusOf(driverId), 'ONLINE');
    });

    it('leaves a renewed driver online', async () => {
      const typeId = await carTypeId();
      const job = container.resolve<SubscriptionExpiryJob>('subscriptionExpiryJob');
      const driverId = await onlineDriver(typeId, { paymentModel: 'SUBSCRIPTION' });
      await makeActiveSubscription(driverId, { expiresInMs: 24 * HOUR });

      assert.equal(await job.run(), 0);
      assert.equal(await statusOf(driverId), 'ONLINE');
    });
  });
});
