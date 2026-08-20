import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState, FIXED_OTP } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import type { AuthService } from '../../src/modules/auth/services/auth.service.js';

const BASE = '/api/v1/auth';

interface Login {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

describe('auth token + session invariants (integration)', () => {
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

  async function login(phone: string): Promise<Login> {
    const sent = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber: phone },
    });
    const challengeId = sent.json().challengeId as string;
    const verified = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber: phone, code: FIXED_OTP, challengeId },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    const body = verified.json();
    return { accessToken: body.accessToken, refreshToken: body.refreshToken, userId: body.user.id };
  }

  const refresh = (refreshToken: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `${BASE}/token/refresh`,
      headers: { 'idempotency-key': key },
      payload: { refreshToken },
    });

  const sessions = (accessToken: string) =>
    app.inject({
      method: 'GET',
      url: `${BASE}/me/sessions`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

  it('rotates the refresh token on use (a new, different pair is issued)', async () => {
    const { refreshToken } = await login('+919876500010');
    const res = await refresh(refreshToken);

    assert.equal(res.statusCode, 200, res.payload);
    assert.notEqual(res.json().refreshToken, refreshToken, 'refresh token rotates');
    assert.ok(res.json().accessToken);
  });

  it('replaying a rotated refresh token is detected as reuse and kills the family (AUTH-INV-5)', async () => {
    const { refreshToken, userId } = await login('+919876500011');
    await refresh(refreshToken);

    const replay = await refresh(refreshToken, randomUUID());
    assert.equal(replay.statusCode, 401, replay.payload);
    assert.equal(replay.json().error.code, 'TOKEN_REUSE');

    const live = await db().client.refreshToken.findMany({
      where: { userId, revokedAt: null },
    });
    assert.equal(live.length, 0, 'all tokens in the family are revoked');
    const types = (await db().client.outboxEvent.findMany()).map((o) => o.eventType);
    assert.ok(types.includes('auth.refresh.reuse_detected'));
  });

  it('a dropped-response retry (same idempotency key) replays, not reuse', async () => {
    const { refreshToken } = await login('+919876500012');
    const key = randomUUID();
    const first = await refresh(refreshToken, key);
    const retry = await refresh(refreshToken, key);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(retry.statusCode, 200, retry.payload);
    assert.equal(retry.json().refreshToken, first.json().refreshToken, 'replayed stored pair');
  });

  it('an authenticated request works, then is SESSION_REVOKED after logout (AUTH-INV-4)', async () => {
    const { accessToken } = await login('+919876500013');

    const before = await sessions(accessToken);
    assert.equal(before.statusCode, 200, before.payload);
    assert.equal(before.json().sessions.length, 1);

    const out = await app.inject({
      method: 'POST',
      url: `${BASE}/logout`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(out.statusCode, 204);

    const after = await sessions(accessToken);
    assert.equal(after.statusCode, 401, after.payload);
    assert.equal(after.json().error.code, 'SESSION_REVOKED');
  });

  it('suspension makes the still-valid access token TOKEN_STALE on the next call (AUTH-INV-3)', async () => {
    const { accessToken, userId } = await login('+919876500014');

    await container.resolve<AuthService>('authService').suspend(userId);

    const res = await sessions(accessToken);
    assert.equal(res.statusCode, 401, res.payload);
    assert.equal(res.json().error.code, 'TOKEN_STALE');
  });
});
