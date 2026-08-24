import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  db,
  FIXED_OTP,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { userConfig } from '../../src/config/user/index.js';
import type { AccountService } from '../../src/modules/users/services/account/account.service.js';
import { UserError } from '../../src/modules/users/errors/user.errors.js';

const LEAVER = '+919876515001';
const DRIVER = '+919876515002';

const DEACTIVATE = '/api/v1/users/me/deactivate';
const DELETE_REQUEST = '/api/v1/users/me/delete-request';

describe('account departure (integration)', () => {
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

  function post(url: string, user: LoggedInUser, payload?: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: user.authHeader,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  function probe(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async function events(eventType: string) {
    const rows = await db().client.outboxEvent.findMany({ where: { eventType } });
    return rows.map((row) => row.payload as unknown as { data: Record<string, unknown> });
  }

  async function seedActiveRide(
    customerId: string,
    options: { status?: string; paymentStatus?: string } = {},
  ): Promise<string> {
    const client = db().client;
    const driverAccount = await loginAs(app, DRIVER);
    const vehicleType = await client.vehicleType.create({
      data: { code: `TYPE-${randomUUID().slice(0, 8)}`, name: 'Hatchback' },
    });
    const vehicle = await client.vehicle.create({
      data: {
        registrationNumber: `KA01${randomUUID().slice(0, 6)}`,
        vehicleTypeId: vehicleType.id,
      },
    });
    const driver = await client.driver.create({
      data: { userId: driverAccount.userId, driverCode: `DRV-${randomUUID().slice(0, 8)}` },
    });

    const requestId = randomUUID();
    const rideId = randomUUID();
    await client.$executeRaw`
      INSERT INTO ride_requests (id, customer_id, vehicle_type_id, pickup_lat, pickup_lng, pickup_location)
      VALUES (
        ${requestId}::uuid, ${customerId}::uuid, ${vehicleType.id}::uuid, 12.9716, 77.5946,
        ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography
      )`;
    await client.$executeRaw`
      INSERT INTO rides (
        id, ride_code, request_id, customer_id, driver_id, vehicle_id, vehicle_type_id,
        status, payment_method, payment_status, pickup_location, updated_at
      ) VALUES (
        ${rideId}::uuid, ${`RIDE-${randomUUID().slice(0, 8)}`}, ${requestId}::uuid,
        ${customerId}::uuid, ${driver.id}::uuid, ${vehicle.id}::uuid, ${vehicleType.id}::uuid,
        ${options.status ?? 'IN_PROGRESS'}::"RideStatus", 'CASH',
        ${options.paymentStatus ?? 'PENDING'}::"PaymentStatus",
        ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
        now()
      )`;
    return rideId;
  }

  // ── Deactivation ──────────────────────────────────────────────────────────

  it('ends access on every device and leaves the row in place', async () => {
    const first = await loginAs(app, LEAVER);
    const second = await loginAs(app, LEAVER);

    const response = await post(DEACTIVATE, first, { reason: 'NOT_USING' });
    assert.equal(response.statusCode, 204, response.payload);
    assert.equal(response.payload, '', 'a 204 carries no body');

    // Criterion 06 §3 #8: the next request from either device is TOKEN_STALE.
    for (const [label, token] of [
      ['the caller', first.accessToken],
      ['the other device', second.accessToken],
    ] as const) {
      const after = await probe(token);
      assert.equal(after.statusCode, 401, label);
      assert.equal(after.json().error.code, 'TOKEN_STALE', label);
    }

    // USER-INV-6: nothing was removed.
    const row = await db().client.user.findUniqueOrThrow({ where: { id: first.userId } });
    assert.equal(row.status, 'DEACTIVATED');
    assert.equal(row.deletedAt, null, 'deactivation is not deletion');
    assert.equal(
      await db().client.userProfile.count({ where: { userId: first.userId } }),
      1,
      'the profile survives — erasure is the retention job’s work, never this endpoint’s',
    );

    const active = await db().client.userSession.findMany({
      where: { userId: first.userId, revokedAt: null },
    });
    assert.equal(active.length, 0, 'every session ended, including the caller’s own');
  });

  it('audits the departure as the user’s own, with the coarse reason', async () => {
    const user = await loginAs(app, LEAVER);
    assert.equal((await post(DEACTIVATE, user, { reason: 'PRIVACY' })).statusCode, 204);

    const [deactivated] = await events('user.account.deactivated');
    assert.ok(deactivated, 'deactivation is never silent (R-USER-20)');
    assert.deepEqual(deactivated.data, {
      userId: user.userId,
      actor: 'self',
      reason: 'PRIVACY',
    });

    // The revocations are audited too, one per session that was open.
    const revoked = await events('auth.session.revoked');
    assert.equal(revoked.filter((e) => e.data.reason === 'deactivated').length, 1);
  });

  it('accepts a departure with no reason at all', async () => {
    const user = await loginAs(app, LEAVER);
    assert.equal((await post(DEACTIVATE, user)).statusCode, 204);
    assert.deepEqual((await events('user.account.deactivated'))[0]?.data, {
      userId: user.userId,
      actor: 'self',
    });
  });

  it('refuses free text where a coarse reason belongs (doc 05 §3.3)', async () => {
    const user = await loginAs(app, LEAVER);
    const response = await post(DEACTIVATE, user, { reason: 'your app is terrible' });

    assert.equal(response.statusCode, 400);
    const error = response.json().error;
    assert.equal(error.code, 'VALIDATION');
    assert.deepEqual(error.details, [{ field: 'reason', code: 'NOT_ALLOWED' }]);
    // Free text is where a personal value leaks into the event stream — so it must
    // not come back out in the error body either (doc 04 §5).
    assert.ok(!JSON.stringify(error).includes('terrible'));

    const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
    assert.equal(row.status, 'ACTIVE', 'a rejected body changed nothing');
  });

  // ── Obligations, R-USER-21 ────────────────────────────────────────────────

  describe('obligations (R-USER-21)', () => {
    it('refuses while a ride is in flight, naming the module', async () => {
      const user = await loginAs(app, LEAVER);
      await seedActiveRide(user.userId);

      const response = await post(DEACTIVATE, user);
      assert.equal(response.statusCode, 409, response.payload);
      const error = response.json().error;
      assert.equal(error.code, 'ACCOUNT_HAS_OBLIGATIONS');
      assert.deepEqual(error.details, [{ field: 'rides', code: 'RIDE_IN_PROGRESS' }]);

      const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(row.status, 'ACTIVE', 'the account is untouched');
      assert.equal((await probe(user.accessToken)).statusCode, 200, 'and still usable');
    });

    it('refuses while a wallet balance is unsettled', async () => {
      const user = await loginAs(app, LEAVER);
      await db().client.customerWallet.create({ data: { userId: user.userId, balance: 250.5 } });

      const response = await post(DEACTIVATE, user);
      assert.equal(response.statusCode, 409, response.payload);
      assert.deepEqual(response.json().error.details, [
        { field: 'wallet', code: 'BALANCE_UNSETTLED' },
      ]);
    });

    // The other direction — the customer owing the platform — used to be seeded
    // here as `balance: -75`. It cannot be: the wallet balance floor added for
    // FR-003 forbids a negative balance, and an outstanding fare is now the
    // obligation state `Ride.paymentStatus = FAILED` (data-model §2A). Same
    // assertion, current representation.
    it('refuses while a completed ride is still unpaid', async () => {
      const user = await loginAs(app, LEAVER);
      await seedActiveRide(user.userId, { status: 'COMPLETED', paymentStatus: 'FAILED' });

      const response = await post(DEACTIVATE, user);
      assert.equal(response.statusCode, 409, response.payload);
      assert.deepEqual(response.json().error.details, [
        { field: 'payments', code: 'PAYMENT_UNSETTLED' },
      ]);
    });

    it('lets a written-off receivable through — BD-1c closes the obligation', async () => {
      const user = await loginAs(app, LEAVER);
      const rideId = await seedActiveRide(user.userId, {
        status: 'COMPLETED',
        paymentStatus: 'FAILED',
      });
      await db().client.ridePayment.create({
        data: { rideId, amount: 180, method: 'CASH', status: 'WRITTEN_OFF' },
      });

      assert.equal((await post(DEACTIVATE, user)).statusCode, 204);
    });

    it('refuses while every last rupee is committed to a hold', async () => {
      const user = await loginAs(app, LEAVER);
      // A hold is a transaction still in flight, not settled funds — the
      // available balance here is zero even though the wallet is not empty.
      //
      // It used to be seeded as `balance: 0, lockedBalance: 100`, which the
      // balance/hold invariant added for FR-003 now forbids, and rightly:
      // `hold()` has always refused to lock funds that are not there, so no
      // request could ever have produced that row.
      await db().client.customerWallet.create({
        data: { userId: user.userId, balance: 100, lockedBalance: 100 },
      });
      assert.equal((await post(DEACTIVATE, user)).statusCode, 409);
    });

    it('lets a settled, empty wallet through', async () => {
      const user = await loginAs(app, LEAVER);
      await db().client.customerWallet.create({ data: { userId: user.userId, balance: 0 } });
      assert.equal((await post(DEACTIVATE, user)).statusCode, 204);
    });

    it('refuses while a dispute is open, and allows a closed one', async () => {
      const open = await loginAs(app, LEAVER);
      const ticket = await db().client.supportTicket.create({
        data: {
          userId: open.userId,
          ticketNumber: `TKT-${randomUUID().slice(0, 8)}`,
          subject: 'Driver took the wrong turn',
          status: 'OPEN',
        },
      });
      assert.deepEqual((await post(DEACTIVATE, open)).json().error.details, [
        { field: 'support', code: 'DISPUTE_OPEN' },
      ]);

      await db().client.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'CLOSED' },
      });
      assert.equal(
        (await post(DEACTIVATE, open)).statusCode,
        204,
        'a closed ticket blocks nothing',
      );
    });

    it('names every blocker at once, not one per attempt', async () => {
      const user = await loginAs(app, LEAVER);
      await seedActiveRide(user.userId);
      await db().client.customerWallet.create({ data: { userId: user.userId, balance: 40 } });
      await db().client.supportTicket.create({
        data: {
          userId: user.userId,
          ticketNumber: `TKT-${randomUUID().slice(0, 8)}`,
          subject: 'Refund not received',
        },
      });

      const response = await post(DEACTIVATE, user);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json().error.details, [
        { field: 'rides', code: 'RIDE_IN_PROGRESS' },
        { field: 'wallet', code: 'BALANCE_UNSETTLED' },
        { field: 'support', code: 'DISPUTE_OPEN' },
      ]);
    });

    it('is not blocked by another account’s obligations', async () => {
      const user = await loginAs(app, LEAVER);
      const stranger = await loginAs(app, DRIVER);
      await db().client.customerWallet.create({ data: { userId: stranger.userId, balance: 999 } });

      assert.equal((await post(DEACTIVATE, user)).statusCode, 204);
    });
  });

  // ── Delete request ────────────────────────────────────────────────────────

  describe('delete request (doc 02 §2.8)', () => {
    it('deactivates immediately and schedules erasure for later', async () => {
      const user = await loginAs(app, LEAVER);
      const response = await post(DELETE_REQUEST, user);

      assert.equal(response.statusCode, 202, response.payload);
      const scheduled = new Date(response.json().scheduledFor).getTime();
      const expected = Date.now() + userConfig.deletionRetentionDays * 86_400_000;
      assert.ok(Math.abs(scheduled - expected) < 60_000, response.payload);

      // The request deactivates now; erasure is the retention job's work (R-USER-19).
      const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(row.status, 'DEACTIVATED');
      assert.equal(row.deletedAt, null, 'the endpoint deletes nothing');
      assert.equal((await probe(user.accessToken)).json().error.code, 'TOKEN_STALE');
    });

    it('audits both the departure and the request, together', async () => {
      const user = await loginAs(app, LEAVER);
      const { scheduledFor } = (await post(DELETE_REQUEST, user)).json();

      assert.equal((await events('user.account.deactivated')).length, 1);
      assert.deepEqual((await events('user.account.deletion_requested'))[0]?.data, {
        userId: user.userId,
        scheduledFor,
      });
    });

    it('is refused by the same obligations as a plain deactivation', async () => {
      const user = await loginAs(app, LEAVER);
      await db().client.customerWallet.create({ data: { userId: user.userId, balance: 10 } });

      const response = await post(DELETE_REQUEST, user);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'ACCOUNT_HAS_OBLIGATIONS');
      assert.equal((await events('user.account.deletion_requested')).length, 0);
    });
  });

  // ── USER-INV-6 ────────────────────────────────────────────────────────────

  it('frees the number only once the row is soft-deleted, and inherits nothing', async () => {
    const original = await loginAs(app, LEAVER);
    await db().client.userProfile.update({
      where: { userId: original.userId },
      data: { firstName: 'Priya' },
    });
    assert.equal((await post(DELETE_REQUEST, original)).statusCode, 202);

    // The number is still taken while the row is live: a deactivated account is
    // not a freed one, so re-registering resolves the same identity and is refused
    // at the gate rather than minting a second one.
    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber: LEAVER },
    });
    assert.equal(reused.statusCode, 200, 'the send itself never reveals account state');

    // …and the gate is on `verify`, which is where it has to be. This assertion

    const reverify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber: LEAVER, code: FIXED_OTP, challengeId: reused.json().challengeId },
    });
    assert.equal(reverify.statusCode, 403, reverify.payload);
    assert.equal(reverify.json().error.code, 'ACCOUNT_DEACTIVATED');

    assert.equal(
      await db().client.user.count({ where: { phoneNumber: LEAVER, deletedAt: null } }),
      1,
      'still exactly one live row for the number',
    );

    await db().client.user.update({
      where: { id: original.userId },
      data: { deletedAt: new Date() },
    });

    const fresh = await loginAs(app, LEAVER);
    assert.notEqual(fresh.userId, original.userId, 'a new identity, not the old one restored');

    const profile = await db().client.userProfile.findUnique({ where: { userId: fresh.userId } });
    assert.equal(profile?.firstName, null, 'and none of the old history came with it');
    assert.ok(
      await db().client.user.findUnique({ where: { id: original.userId } }),
      'the old row still exists — records are soft-deleted, never removed (R-USER-19)',
    );
  });

  async function attemptLogin(phoneNumber: string) {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber, code: FIXED_OTP, challengeId: sent.json().challengeId },
    });
  }

  describe('a closed account cannot authenticate', () => {
    it('refuses the login and issues nothing', async () => {
      const user = await loginAs(app, LEAVER);
      assert.equal((await post(DEACTIVATE, user)).statusCode, 204);

      const sessionsBefore = await db().client.userSession.count({
        where: { userId: user.userId },
      });

      const response = await attemptLogin(LEAVER);
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'ACCOUNT_DEACTIVATED');
      assert.ok(!response.payload.includes('accessToken'), 'no token pair in the body');

      assert.equal(
        await db().client.userSession.count({ where: { userId: user.userId } }),
        sessionsBefore,
        'no session row was created',
      );
      assert.equal(
        await db().client.userSession.count({ where: { userId: user.userId, revokedAt: null } }),
        0,
        'and none of them is live',
      );
      assert.equal(
        await db().client.refreshToken.count({
          where: { userId: user.userId, revokedAt: null },
        }),
        0,
        'no refresh token survived or was minted',
      );
    });

    it('does not quietly reactivate the account, or record a login', async () => {
      const user = await loginAs(app, LEAVER);
      const before = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal((await post(DEACTIVATE, user)).statusCode, 204);

      await attemptLogin(LEAVER);

      const after = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(after.status, 'DEACTIVATED', 'the status the user chose is still theirs');
      assert.deepEqual(after.lastLoginAt, before.lastLoginAt, 'a refusal is not a login');
    });

    it('leaves a pending deletion request exactly where it was', async () => {
      const user = await loginAs(app, LEAVER);
      assert.equal((await post(DELETE_REQUEST, user)).statusCode, 202);

      const before = await db().client.accountDeletionRequest.findFirstOrThrow({
        where: { userId: user.userId },
      });

      const response = await attemptLogin(LEAVER);
      assert.equal(response.statusCode, 403);

      const after = await db().client.accountDeletionRequest.findFirstOrThrow({
        where: { userId: user.userId },
      });
      assert.equal(after.status, before.status, 'still pending — a login cannot cancel it');
      assert.deepEqual(after.scheduledFor, before.scheduledFor, 'and the date did not move');
    });

    it('turns away a suspended account with its own code', async () => {
      const user = await loginAs(app, LEAVER);
      await db().client.user.update({
        where: { id: user.userId },
        data: { status: 'SUSPENDED' },
      });

      const response = await attemptLogin(LEAVER);
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(
        response.json().error.code,
        'ACCOUNT_SUSPENDED',
        'an ops suspension is appealed, a self-deactivation is restored — different copy',
      );
    });

    it('still lets an untouched account log in', async () => {
      const response = await attemptLogin(DRIVER);
      assert.equal(response.statusCode, 200, response.payload);
      assert.ok(response.json().accessToken);
    });
  });

  describe('two lifecycle operations racing one account', () => {
    it('audits one departure, not two, when deactivate races delete-request', async () => {
      const user = await loginAs(app, LEAVER);

      const [deactivate, deleteRequest] = await Promise.all([
        post(DEACTIVATE, user),
        post(DELETE_REQUEST, user),
      ]);

      const codes = [deactivate.statusCode, deleteRequest.statusCode].sort();
      assert.deepEqual(codes, [202, 204], `${deactivate.payload} / ${deleteRequest.payload}`);

      assert.equal(
        (await events('user.account.deactivated')).length,
        1,
        'one departure, one audit row',
      );

      const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(row.status, 'DEACTIVATED');
    });

    it('opens at most one deletion request when two arrive together', async () => {
      const user = await loginAs(app, LEAVER);

      const responses = await Promise.all([post(DELETE_REQUEST, user), post(DELETE_REQUEST, user)]);
      for (const response of responses) {
        assert.equal(response.statusCode, 202, response.payload);
      }

      const pending = await db().client.accountDeletionRequest.findMany({
        where: { userId: user.userId, status: 'PENDING' },
      });
      assert.equal(pending.length, 1, 'a second request must not open a second ledger row');

      const dates = new Set(responses.map((r) => r.json().scheduledFor));
      assert.equal(dates.size, 1, 'and both callers were quoted that same date');
    });

    it('lets neither through while an obligation is open', async () => {
      const user = await loginAs(app, LEAVER);
      await seedActiveRide(user.userId);

      const responses = await Promise.all([post(DEACTIVATE, user), post(DELETE_REQUEST, user)]);
      for (const response of responses) {
        assert.equal(response.statusCode, 409, response.payload);
        assert.equal(response.json().error.code, 'ACCOUNT_HAS_OBLIGATIONS');
      }

      const row = await db().client.user.findUniqueOrThrow({ where: { id: user.userId } });
      assert.equal(row.status, 'ACTIVE', 'the obligation check held under contention too');
    });
  });

  describe('restore (R-USER-17)', () => {
    function accountService(): AccountService {
      return container.resolve<AccountService>('accountService');
    }

    it('lets a restored account authenticate again, as the same identity', async () => {
      const original = await loginAs(app, LEAVER);
      await db().client.userProfile.update({
        where: { userId: original.userId },
        data: { firstName: 'Priya' },
      });
      assert.equal((await post(DEACTIVATE, original)).statusCode, 204);

      const operator = await loginAs(app, DRIVER);
      await accountService().restore(original.userId, operator.userId);

      const row = await db().client.user.findUniqueOrThrow({ where: { id: original.userId } });
      assert.equal(row.status, 'ACTIVE');

      const returned = await loginAs(app, LEAVER);
      assert.equal(returned.userId, original.userId);
      const profile = await db().client.userProfile.findUnique({
        where: { userId: original.userId },
      });
      assert.equal(profile?.firstName, 'Priya', 'the profile came back with the account');
    });

    it('does not give back the credentials the departure revoked', async () => {
      const original = await loginAs(app, LEAVER);
      assert.equal((await post(DEACTIVATE, original)).statusCode, 204);

      const operator = await loginAs(app, DRIVER);
      await accountService().restore(original.userId, operator.userId);

      const stale = await probe(original.accessToken);
      assert.equal(stale.statusCode, 401);
      assert.equal(stale.json().error.code, 'TOKEN_STALE');
      assert.equal(
        await db().client.userSession.count({
          where: { userId: original.userId, revokedAt: null },
        }),
        0,
        'no revoked session was revived',
      );
    });

    it('emits USER’s restore, not AUTH’s reactivation', async () => {
      const original = await loginAs(app, LEAVER);
      assert.equal((await post(DEACTIVATE, original)).statusCode, 204);
      const operator = await loginAs(app, DRIVER);
      await accountService().restore(original.userId, operator.userId);

      const [restored] = await events('user.account.restored');
      assert.ok(restored, 'the restore is audited (R-USER-20)');
      assert.deepEqual(restored.data, {
        userId: original.userId,
        actor: 'admin',
        actorId: operator.userId,
      });

      assert.equal((await events('account.reactivated')).length, 0);
    });

    it('refuses an account that was never self-deactivated', async () => {
      const active = await loginAs(app, LEAVER);
      const operator = await loginAs(app, DRIVER);

      await assert.rejects(
        accountService().restore(active.userId, operator.userId),
        (err: unknown) => err instanceof UserError && err.code === 'CONFLICT',
      );
      assert.equal((await events('user.account.restored')).length, 0);
      assert.equal((await probe(active.accessToken)).statusCode, 200, 'and it stays usable');
    });

    it('refuses an identity the retention job has already erased', async () => {
      const original = await loginAs(app, LEAVER);
      const operator = await loginAs(app, DRIVER);
      assert.equal((await post(DEACTIVATE, original)).statusCode, 204);
      await db().client.user.update({
        where: { id: original.userId },
        data: { deletedAt: new Date() },
      });

      await assert.rejects(
        accountService().restore(original.userId, operator.userId),
        (err: unknown) => err instanceof UserError && err.code === 'NOT_FOUND',
      );
    });
  });

  it('is closed to unauthenticated callers', async () => {
    for (const url of [DEACTIVATE, DELETE_REQUEST]) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().error.code, 'TOKEN_INVALID', url);
    }
  });
});
