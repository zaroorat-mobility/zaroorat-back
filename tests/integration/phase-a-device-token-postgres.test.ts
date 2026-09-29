import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import type { DeviceService } from '../../src/modules/auth/services/session/device.service.js';
import type { AuthService } from '../../src/modules/auth/services/auth.service.js';

/// PA-5 / PA-6 / PA-7 against real PostgreSQL.
///
/// Every one of these behaviours was previously verified only against in-memory
/// doubles — a hand-rolled row store for PA-5, and a *simulated* transaction for
/// PA-6 that staged writes and discarded them on throw. A simulated rollback
/// proves the service puts both writes in one transaction; it cannot prove
/// PostgreSQL rolls them back. These run the real repository, the real
/// `TransactionManager`, and the real database, and assert with SQL.
///
/// Requires migration `20260924000000_user_device_revoked_at`.

const USER_A = '+919876531001';
const USER_B = '+919876531002';
const USER_C = '+919876531003';

const PUSH_TOKEN_URL = '/api/v1/auth/me/device/push-token';

interface Session {
  userId: string;
  accessToken: string;
  authHeader: { authorization: string };
}

describe('Phase A device/token behaviour against real PostgreSQL', () => {
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

  /// `deviceId` omitted reproduces the shipped customer app, which sent no
  /// `device` at login and so got a session row with a NULL `device_id`.
  async function login(phoneNumber: string, deviceId?: string): Promise<Session> {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        phoneNumber,
        code: FIXED_OTP,
        challengeId: sent.json().challengeId,
        ...(deviceId ? { device: { deviceId, platform: 'ANDROID' } } : {}),
      },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    const body = verified.json();
    return {
      userId: body.user.id,
      accessToken: body.accessToken,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  function registerToken(session: Session, fcmToken: string, deviceId?: string) {
    return app.inject({
      method: 'POST',
      url: PUSH_TOKEN_URL,
      headers: session.authHeader,
      payload: { fcmToken, ...(deviceId ? { deviceId } : {}) },
    });
  }

  /// Reads straight from PostgreSQL. No repository in the path, so a repository
  /// bug cannot hide behind its own abstraction.
  async function rows(userId: string): Promise<
    Array<{
      id: string;
      device_id: string | null;
      fcm_token: string | null;
      trust_state: string;
      revoked_at: Date | null;
    }>
  > {
    return db().client.$queryRaw`
      SELECT id, device_id, fcm_token, trust_state, revoked_at
      FROM user_devices WHERE user_id = ${userId}::uuid
      ORDER BY created_at
    `;
  }

  async function rowById(id: string): Promise<{
    fcm_token: string | null;
    trust_state: string;
    revoked_at: Date | null;
  } | null> {
    const found = await db().client.$queryRaw<
      Array<{ fcm_token: string | null; trust_state: string; revoked_at: Date | null }>
    >`SELECT fcm_token, trust_state, revoked_at FROM user_devices WHERE id = ${id}::uuid`;
    return found[0] ?? null;
  }

  const deviceRepo = (): DeviceRepository =>
    container.resolve<DeviceRepository>('deviceRepository');
  const deviceService = (): DeviceService => container.resolve<DeviceService>('deviceService');
  const authService = (): AuthService => container.resolve<AuthService>('authService');

  // ── PA-5 · real token/trust behaviour ────────────────────────────────────

  describe('PA-5 · findLatestFcmToken against PostgreSQL', () => {
    it('returns the active device token', async () => {
      const a = await login(USER_A, 'dev-a1');
      assert.equal((await registerToken(a, 'tok-active-1')).statusCode, 200);

      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), 'tok-active-1');
    });

    it('excludes a REVOKED device even when it is the most recently seen', async () => {
      // The exact defect shape: the revoked row is newest and still held a token.
      //
      // Both devices are created by logging in twice and registering each token
      // through its own session. (The body-`deviceId` path used to 500 on client
      // ids; PA-8a fixed that and covers it below.)
      const a = await login(USER_A, 'dev-old');
      assert.equal((await registerToken(a, 'tok-old')).statusCode, 200);
      const oldRow = (await rows(a.userId))[0]!;

      const aNewer = await login(USER_A, 'dev-new');
      assert.equal((await registerToken(aNewer, 'tok-new')).statusCode, 200);
      const newRow = (await rows(a.userId)).find((r) => r.device_id === 'dev-new')!;

      // Sanity: before revocation the newer device wins, because registering its
      // token touched lastSeenAt after the older one's.
      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), 'tok-new');

      // Revoke the newer one. PA-6 nulls its token; PA-5 also excludes it by state.
      await deviceService().revoke(newRow.id, 'test');

      const selected = await deviceRepo().findLatestFcmToken(a.userId);
      assert.equal(selected, 'tok-old', 'must fall back to the active device');
      assert.notEqual(selected, 'tok-new');
      assert.equal((await rowById(oldRow.id))?.fcm_token, 'tok-old');
    });

    it('returns null when every device the user has is revoked', async () => {
      const a = await login(USER_A, 'dev-only');
      assert.equal((await registerToken(a, 'tok-only')).statusCode, 200);
      const only = (await rows(a.userId))[0]!;

      await deviceService().revoke(only.id, 'test');

      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), null);
    });
  });

  // ── PA-6 · cross-user collision, in one real transaction ─────────────────

  describe('PA-6 · cross-user token release against PostgreSQL', () => {
    it('releases the token from the previous owner and preserves the claimant', async () => {
      const a = await login(USER_A, 'handset-x');
      assert.equal((await registerToken(a, 'shared-handset-token')).statusCode, 200);
      const aRow = (await rows(a.userId))[0]!;
      assert.equal(aRow.fcm_token, 'shared-handset-token');

      // Same physical handset, different account.
      const b = await login(USER_B, 'handset-x');
      assert.equal((await registerToken(b, 'shared-handset-token')).statusCode, 200);
      const bRow = (await rows(b.userId))[0]!;

      assert.equal(
        (await rowById(aRow.id))?.fcm_token,
        null,
        "the previous owner's token must be released in PostgreSQL",
      );
      assert.equal(bRow.fcm_token, 'shared-handset-token', 'the claimant must hold it');

      // And the delivery consequence: A is no longer deliverable to that handset.
      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), null);
      assert.equal(await deviceRepo().findLatestFcmToken(b.userId), 'shared-handset-token');
    });

    it('leaves unrelated users and unrelated tokens untouched', async () => {
      const c = await login(USER_C, 'other-handset');
      assert.equal((await registerToken(c, 'unrelated-token')).statusCode, 200);
      const cRow = (await rows(c.userId))[0]!;

      const a = await login(USER_A, 'handset-y');
      assert.equal((await registerToken(a, 'contested-token')).statusCode, 200);
      const b = await login(USER_B, 'handset-y');
      assert.equal((await registerToken(b, 'contested-token')).statusCode, 200);

      assert.equal((await rowById(cRow.id))?.fcm_token, 'unrelated-token');
    });

    it('rolls back the release in PostgreSQL when the claim fails', async () => {
      // The case the simulated transaction could only approximate. The release
      // commits nothing unless the claim commits too — otherwise the previous
      // owner is stripped of a token nobody took ownership of.
      const a = await login(USER_A, 'handset-z');
      assert.equal((await registerToken(a, 'rollback-token')).statusCode, 200);
      const aRow = (await rows(a.userId))[0]!;

      const b = await login(USER_B, 'handset-z');
      const bRowBefore = (await rows(b.userId))[0]!;

      const repo = deviceRepo();
      const realUpdate = repo.updateFcmToken.bind(repo);
      (repo as unknown as Record<string, unknown>).updateFcmToken = async (): Promise<never> => {
        throw new Error('simulated claim failure inside the transaction');
      };

      try {
        await assert.rejects(
          () =>
            authService().updatePushToken(b.userId, 'no-session', 'rollback-token', bRowBefore.id),
          /simulated claim failure/,
        );
      } finally {
        (repo as unknown as Record<string, unknown>).updateFcmToken = realUpdate;
      }

      // PostgreSQL must have rolled the release back.
      assert.equal(
        (await rowById(aRow.id))?.fcm_token,
        'rollback-token',
        'the release must be rolled back by PostgreSQL when the claim throws',
      );
      assert.equal(
        (await rowById(bRowBefore.id))?.fcm_token,
        null,
        'the claim must not be visible',
      );
    });
  });

  // ── PA-6 · revokedAt lifecycle ───────────────────────────────────────────

  describe('PA-6 · revokedAt in PostgreSQL', () => {
    it('writes revokedAt and nulls fcmToken when a device becomes REVOKED', async () => {
      const a = await login(USER_A, 'dev-rev');
      assert.equal((await registerToken(a, 'tok-rev')).statusCode, 200);
      const row = (await rows(a.userId))[0]!;
      assert.equal(row.revoked_at, null, 'not revoked yet');

      const before = Date.now();
      await deviceService().revoke(row.id, 'test');
      const after = Date.now();

      const revoked = await rowById(row.id);
      assert.equal(revoked?.trust_state, 'REVOKED');
      assert.equal(revoked?.fcm_token, null, 'a revoked device must not stay deliverable');
      assert.ok(revoked?.revoked_at, 'revoked_at must be populated in PostgreSQL');
      const stamped = new Date(revoked!.revoked_at!).getTime();
      assert.ok(
        stamped >= before - 1000 && stamped <= after + 1000,
        `revoked_at must be the revocation instant, got ${revoked?.revoked_at}`,
      );
    });

    it('clears revokedAt when the device transitions back out of REVOKED', async () => {
      // Otherwise a re-registered device still looks revoked to a sweep that
      // purges by age of revocation.
      const a = await login(USER_A, 'dev-round');
      assert.equal((await registerToken(a, 'tok-round')).statusCode, 200);
      const row = (await rows(a.userId))[0]!;

      await deviceService().revoke(row.id, 'test');
      assert.ok((await rowById(row.id))?.revoked_at, 'revoked first');

      await deviceService().markTrusted(row.id);

      const back = await rowById(row.id);
      assert.equal(back?.trust_state, 'TRUSTED');
      assert.equal(back?.revoked_at, null, 'revoked_at must be cleared on the way out of REVOKED');
    });

    it('re-registering a revoked device makes it deliverable again', async () => {
      const a = await login(USER_A, 'dev-reg');
      assert.equal((await registerToken(a, 'tok-first')).statusCode, 200);
      const row = (await rows(a.userId))[0]!;

      await deviceService().revoke(row.id, 'test');
      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), null);

      // register() flips REVOKED back to REGISTERED, which also clears revoked_at.
      await deviceService().register({ userId: a.userId, deviceId: 'dev-reg' });
      const reRegistered = await rowById(row.id);
      assert.equal(reRegistered?.trust_state, 'REGISTERED');
      assert.equal(reRegistered?.revoked_at, null);
    });
  });

  // ── PA-6 · NULL deviceId refusal ─────────────────────────────────────────

  describe('PA-6 · unbound device rows are refused by PostgreSQL-backed path', () => {
    it('creates no NULL-deviceId row when no device can be resolved', async () => {
      const a = await login(USER_A, 'dev-bound');
      const before = await rows(a.userId);

      await assert.rejects(() =>
        authService().updatePushToken(a.userId, 'session-that-has-no-device', 'tok-unbound'),
      );

      const after = await rows(a.userId);
      assert.equal(after.length, before.length, 'no device row may be created');
      assert.equal(
        after.filter((r) => r.device_id === null).length,
        0,
        'no NULL-deviceId row may exist',
      );
    });
  });

  // ── PA-7 · logout clears the real token ──────────────────────────────────

  describe('PA-7 · logout token cleanup in PostgreSQL', () => {
    it('logout clears the fcmToken of the session device and leaves the row registered', async () => {
      const a = await login(USER_A, 'dev-logout');
      assert.equal((await registerToken(a, 'tok-logout')).statusCode, 200);
      const row = (await rows(a.userId))[0]!;
      assert.equal(row.fcm_token, 'tok-logout');

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: a.authHeader,
        payload: {},
      });
      assert.ok(out.statusCode >= 200 && out.statusCode < 300, out.payload);

      const cleared = await rowById(row.id);
      assert.equal(cleared?.fcm_token, null, 'logout must clear the token in PostgreSQL');
      // Logout is not revocation: the device stays registered and re-registerable.
      assert.equal(cleared?.trust_state, 'REGISTERED');
      assert.equal(cleared?.revoked_at, null);
    });

    it('logoutAll clears every device token the user holds', async () => {
      const a = await login(USER_A, 'dev-multi-1');
      assert.equal((await registerToken(a, 'tok-multi-1')).statusCode, 200);
      // Second device via a second login, for the reason noted above.
      const a2 = await login(USER_A, 'dev-multi-2');
      assert.equal((await registerToken(a2, 'tok-multi-2')).statusCode, 200);

      const before = await rows(a.userId);
      assert.equal(before.filter((r) => r.fcm_token !== null).length, 2, 'two deliverable devices');

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: a.authHeader,
        payload: { allDevices: true },
      });
      assert.ok(out.statusCode >= 200 && out.statusCode < 300, out.payload);

      const after = await rows(a.userId);
      assert.equal(
        after.filter((r) => r.fcm_token !== null).length,
        0,
        'logoutAll must clear every token in PostgreSQL',
      );
      assert.equal(
        after.filter((r) => r.trust_state === 'REGISTERED').length,
        after.length,
        'logoutAll must not revoke devices',
      );
      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), null);
    });
  });

  // ── PA-8a · device id contract ───────────────────────────────────────────
  //
  // Request `deviceId` = the client's stable id (`user_devices.device_id`).
  // Response `data.deviceId` = the server row id (`user_devices.id`).

  describe('PA-8a · body deviceId against PostgreSQL', () => {
    async function sessionDeviceIds(userId: string): Promise<Array<string | null>> {
      const found = await db().client.$queryRaw<Array<{ device_id: string | null }>>`
        SELECT device_id FROM user_sessions WHERE user_id = ${userId}::uuid ORDER BY created_at
      `;
      return found.map((r) => r.device_id);
    }

    it('1 · driver-style: login and push with the same client id use one row', async () => {
      const a = await login(USER_A, 'dev-a1');

      const res = await registerToken(a, 'tok-driver', 'dev-a1');
      assert.equal(res.statusCode, 200, res.payload);

      const all = await rows(a.userId);
      assert.equal(all.length, 1, 'exactly one device row');
      assert.equal(all[0]!.device_id, 'dev-a1');
      assert.equal(all[0]!.fcm_token, 'tok-driver');
      assert.equal(res.json().data.deviceId, all[0]!.id, 'response deviceId is the row UUID');
    });

    it('2 · customer legacy: the NULL session row takes the client id and the token', async () => {
      const a = await login(USER_A);
      const before = await rows(a.userId);
      assert.equal(before.length, 1);
      assert.equal(before[0]!.device_id, null, 'precondition: legacy login row has no client id');

      const res = await registerToken(a, 'tok-legacy', 'dev_cust_legacy');
      assert.equal(res.statusCode, 200, res.payload);

      const after = await rows(a.userId);
      assert.equal(after.length, 1, 'no second row');
      assert.equal(after[0]!.id, before[0]!.id, 'the same row');
      assert.equal(after[0]!.device_id, 'dev_cust_legacy');
      assert.equal(after[0]!.fcm_token, 'tok-legacy');
      assert.deepEqual(await sessionDeviceIds(a.userId), [after[0]!.id], 'still the session row');
      assert.equal(res.json().data.deviceId, after[0]!.id);
    });

    it('3 · customer logout clears the token on the linked session row', async () => {
      const a = await login(USER_A);
      assert.equal((await registerToken(a, 'tok-cust-logout', 'dev_cust_lo')).statusCode, 200);
      const linked = (await rows(a.userId))[0]!;
      assert.equal(linked.fcm_token, 'tok-cust-logout');

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: a.authHeader,
        payload: {},
      });
      assert.ok(out.statusCode >= 200 && out.statusCode < 300, out.payload);

      const after = await rows(a.userId);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.fcm_token, null, 'logout must clear the linked row');
      assert.equal(after[0]!.device_id, 'dev_cust_lo', 'logout keeps the identity');
    });

    it('4 · customer logoutAll clears every token the user holds', async () => {
      const a1 = await login(USER_A);
      assert.equal((await registerToken(a1, 'tok-all-1', 'dev_cust_p1')).statusCode, 200);
      const a2 = await login(USER_A);
      assert.equal((await registerToken(a2, 'tok-all-2', 'dev_cust_p2')).statusCode, 200);
      assert.equal((await rows(a1.userId)).filter((r) => r.fcm_token !== null).length, 2);

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: a1.authHeader,
        payload: { allDevices: true },
      });
      assert.ok(out.statusCode >= 200 && out.statusCode < 300, out.payload);

      assert.equal((await rows(a1.userId)).filter((r) => r.fcm_token !== null).length, 0);
    });

    it('5 · a real row UUID still resolves to that row', async () => {
      const a = await login(USER_A, 'dev-uuid-row');
      const row = (await rows(a.userId))[0]!;

      const res = await registerToken(a, 'tok-by-row', row.id);
      assert.equal(res.statusCode, 200, res.payload);

      const after = await rows(a.userId);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.fcm_token, 'tok-by-row');
      assert.equal(res.json().data.deviceId, row.id);
    });

    it('6 · a UUID-shaped client id that is not a row id resolves by client id', async () => {
      const clientUuid = randomUUID();
      const a = await login(USER_A, clientUuid);
      const row = (await rows(a.userId))[0]!;
      assert.notEqual(row.id, clientUuid);

      const res = await registerToken(a, 'tok-client-uuid', clientUuid);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal((await rows(a.userId)).length, 1);
      assert.equal((await rowById(row.id))?.fcm_token, 'tok-client-uuid');

      // An unseen UUID-shaped client id, with a populated session row, creates a row.
      const fresh = randomUUID();
      const res2 = await registerToken(a, 'tok-fresh-uuid', fresh);
      assert.equal(res2.statusCode, 200, res2.payload);
      const created = (await rows(a.userId)).find((r) => r.device_id === fresh);
      assert.ok(created, 'a row for the new client id');
      assert.equal(created!.fcm_token, 'tok-fresh-uuid');
      assert.equal(
        (await rows(a.userId)).find((r) => r.id === row.id)?.device_id,
        clientUuid,
        'session row not overwritten',
      );
    });

    it('7 · user B cannot attach to user A’s device row', async () => {
      const a = await login(USER_A, 'dev-owned-by-a');
      assert.equal((await registerToken(a, 'tok-a-own')).statusCode, 200);
      const aRow = (await rows(a.userId))[0]!;
      const b = await login(USER_B, 'dev-b-own');

      const byClient = await registerToken(b, 'tok-b-1', 'dev-owned-by-a');
      assert.equal(byClient.statusCode, 200, byClient.payload);
      const byRow = await registerToken(b, 'tok-b-2', aRow.id);
      assert.equal(byRow.statusCode, 200, byRow.payload);

      const aAfter = (await rows(a.userId))[0]!;
      assert.equal(aAfter.id, aRow.id);
      assert.equal(aAfter.device_id, 'dev-owned-by-a');
      assert.equal(aAfter.fcm_token, 'tok-a-own', 'A’s row must be untouched');
      assert.equal((await rows(a.userId)).length, 1, 'nothing created under A');
      assert.notEqual(byClient.json().data.deviceId, aRow.id);
      assert.notEqual(byRow.json().data.deviceId, aRow.id);
    });

    it('8 · PostgreSQL rolls back the release and the link when the claim fails', async () => {
      const a = await login(USER_A, 'handset-rb');
      assert.equal((await registerToken(a, 'rb-link-token')).statusCode, 200);
      const aRow = (await rows(a.userId))[0]!;

      const b = await login(USER_B);
      const bRow = (await rows(b.userId))[0]!;
      assert.equal(bRow.device_id, null);

      const repo = deviceRepo();
      const realUpdate = repo.updateFcmToken.bind(repo);
      (repo as unknown as Record<string, unknown>).updateFcmToken = async (): Promise<never> => {
        throw new Error('simulated claim failure after linking');
      };
      let res;
      try {
        res = await registerToken(b, 'rb-link-token', 'dev_cust_rb');
      } finally {
        (repo as unknown as Record<string, unknown>).updateFcmToken = realUpdate;
      }
      assert.equal(res.statusCode, 500, 'the failure surfaces');

      assert.equal((await rowById(aRow.id))?.fcm_token, 'rb-link-token', 'release rolled back');
      const bAfter = await rows(b.userId);
      assert.equal(bAfter.length, 1, 'no row created');
      assert.equal(bAfter[0]!.device_id, null, 'link rolled back');
      assert.equal(bAfter[0]!.fcm_token, null, 'claim not visible');
    });
  });

  // ── Token ownership · register() and updateFcmToken() obey one invariant ──
  //
  // At most one user may hold a given FCM token. The login path (`register`,
  // reached through OTP verify with `device.fcmToken`) and the push-token path
  // (`updateFcmToken`) must both release it from everyone else before claiming.

  describe('Token ownership · one owner per FCM token', () => {
    /// Distinct users currently holding `token`, straight from PostgreSQL.
    async function holders(token: string): Promise<string[]> {
      const found = await db().client.$queryRaw<Array<{ user_id: string }>>`
        SELECT DISTINCT user_id::text AS user_id FROM user_devices WHERE fcm_token = ${token}
      `;
      return found.map((r) => r.user_id);
    }

    async function loginWithToken(
      phoneNumber: string,
      deviceId: string,
      fcmToken: string,
    ): Promise<Session> {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber },
      });
      assert.equal(sent.statusCode, 200, sent.payload);
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          phoneNumber,
          code: FIXED_OTP,
          challengeId: sent.json().challengeId,
          device: { deviceId, platform: 'ANDROID', fcmToken },
        },
      });
      assert.equal(verified.statusCode, 200, verified.payload);
      const body = verified.json();
      return {
        userId: body.user.id,
        accessToken: body.accessToken,
        authHeader: { authorization: `Bearer ${body.accessToken}` },
      };
    }

    it('1-4 · register(): user B logging in with TOKEN_X takes it from user A', async () => {
      const a = await loginWithToken(USER_A, 'dev-own-a', 'TOKEN_X');
      assert.deepEqual(await holders('TOKEN_X'), [a.userId], 'precondition: A holds it');

      const b = await loginWithToken(USER_B, 'dev-own-b', 'TOKEN_X');

      assert.deepEqual(await holders('TOKEN_X'), [b.userId], 'B is the only holder');
      assert.equal((await rows(a.userId))[0]!.fcm_token, null, 'A no longer holds it');
      assert.equal(await deviceRepo().findLatestFcmToken(a.userId), null);
    });

    it('register(): an existing device row claims the token, not only a new row', async () => {
      const a = await login(USER_A, 'dev-own-existing');
      const b = await loginWithToken(USER_B, 'dev-own-b2', 'TOKEN_E');
      assert.deepEqual(await holders('TOKEN_E'), [b.userId]);

      // A logs in again on the device row that already exists, now with the token.
      await loginWithToken(USER_A, 'dev-own-existing', 'TOKEN_E');

      assert.deepEqual(await holders('TOKEN_E'), [a.userId]);
      assert.equal((await rows(a.userId)).length, 1, 'no second row for the same device');
    });

    it('5 · user A keeps their unrelated tokens', async () => {
      const a = await loginWithToken(USER_A, 'dev-own-a1', 'TOKEN_SHARED');
      await loginWithToken(USER_A, 'dev-own-a2', 'TOKEN_A_ONLY');

      const b = await loginWithToken(USER_B, 'dev-own-b3', 'TOKEN_SHARED');

      assert.deepEqual(await holders('TOKEN_SHARED'), [b.userId]);
      assert.deepEqual(await holders('TOKEN_A_ONLY'), [a.userId], 'unrelated token untouched');
    });

    it('6 · the same user registering the same token is idempotent on both paths', async () => {
      const a = await loginWithToken(USER_A, 'dev-own-idem', 'TOKEN_I');
      const again = await loginWithToken(USER_A, 'dev-own-idem', 'TOKEN_I');
      assert.equal((await registerToken(again, 'TOKEN_I', 'dev-own-idem')).statusCode, 200);
      assert.equal((await registerToken(again, 'TOKEN_I', 'dev-own-idem')).statusCode, 200);

      const all = await rows(a.userId);
      assert.equal(all.length, 1, 'one row');
      assert.equal(all[0]!.fcm_token, 'TOKEN_I');
      assert.deepEqual(await holders('TOKEN_I'), [a.userId]);
    });

    it('register() and updateFcmToken() release each other', async () => {
      const a = await login(USER_A, 'dev-own-mix-a');
      assert.equal((await registerToken(a, 'TOKEN_M', 'dev-own-mix-a')).statusCode, 200);

      const b = await loginWithToken(USER_B, 'dev-own-mix-b', 'TOKEN_M');
      assert.deepEqual(await holders('TOKEN_M'), [b.userId], 'register released updateFcmToken');

      assert.equal((await registerToken(a, 'TOKEN_M', 'dev-own-mix-a')).statusCode, 200);
      assert.deepEqual(await holders('TOKEN_M'), [a.userId], 'updateFcmToken released register');
    });

    it('7 · concurrent updateFcmToken claims of one token leave exactly one owner', async () => {
      const a = await login(USER_A, 'dev-race-a');
      const b = await login(USER_B, 'dev-race-b');
      const c = await login(USER_C, 'dev-race-c');
      const claimants = [];
      for (const s of [a, b, c]) {
        claimants.push({ userId: s.userId, row: (await rows(s.userId))[0]!.id });
      }

      for (let round = 0; round < 15; round += 1) {
        const token = `TOKEN_RACE_${round}`;
        await Promise.all(
          claimants.map((x) => authService().updatePushToken(x.userId, 'unused', token, x.row)),
        );
        const owners = await holders(token);
        assert.equal(owners.length, 1, `round ${round}: ${owners.length} users hold one token`);
      }
    });

    it('7 · concurrent register() claims of one token leave exactly one owner', async () => {
      const a = await login(USER_A, 'dev-lrace-a');
      const b = await login(USER_B, 'dev-lrace-b');
      for (let round = 0; round < 15; round += 1) {
        const token = `TOKEN_LOGIN_RACE_${round}`;
        await Promise.all([
          deviceService().register({
            userId: a.userId,
            deviceId: `lr-a-${round}`,
            fcmToken: token,
          }),
          deviceService().register({
            userId: b.userId,
            deviceId: `lr-b-${round}`,
            fcmToken: token,
          }),
        ]);
        const owners = await holders(token);
        assert.equal(owners.length, 1, `round ${round}: ${owners.length} users hold one token`);
      }
    });

    it('8 · logout clears the claimed token and does not hand it back', async () => {
      await loginWithToken(USER_A, 'dev-own-lo-a', 'TOKEN_L');
      const b = await login(USER_B, 'dev-own-lo-b');
      assert.equal((await registerToken(b, 'TOKEN_L', 'dev-own-lo-b')).statusCode, 200);

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: b.authHeader,
        payload: {},
      });
      assert.ok(out.statusCode >= 200 && out.statusCode < 300, out.payload);

      assert.deepEqual(await holders('TOKEN_L'), [], 'nobody holds it after logout');
    });
  });
});
