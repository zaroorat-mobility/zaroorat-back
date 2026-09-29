import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FcmPushProvider,
  PAYLOAD_TOO_LARGE,
} from '../../../src/integrations/firebase/fcm-push.provider.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// Minimal stub for DeviceRepository — only clearFcmTokenByValue matters here.
function makeDeviceRepo(opts: { shouldThrow?: boolean } = {}): {
  repo: Pick<DeviceRepository, 'clearFcmTokenByValue'>;
  calls: string[];
} {
  const calls: string[] = [];
  const repo: Pick<DeviceRepository, 'clearFcmTokenByValue'> = {
    async clearFcmTokenByValue(token: string) {
      calls.push(token);
      if (opts.shouldThrow) throw new Error('DB error');
    },
  };
  return { repo, calls };
}

/// Builds a firebase-admin `app` stub whose `messaging().send()` resolves or
/// rejects as directed, and captures the message passed to it.
function makeApp(response: { messageId: string } | { errorCode: string; errorMessage?: string }): {
  app: { messaging: () => { send: (msg: unknown) => Promise<string> } };
  capturedMessage: () => unknown;
} {
  let captured: unknown;
  const send = async (msg: unknown): Promise<string> => {
    captured = msg;
    if ('errorCode' in response) {
      const err = Object.assign(new Error(response.errorMessage ?? response.errorCode), {
        code: response.errorCode,
      });
      throw err;
    }
    return response.messageId;
  };
  return {
    app: { messaging: () => ({ send }) },
    capturedMessage: () => captured,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FcmPushProvider', () => {
  const baseMessage = {
    to: 'aaabbbccc_fcm_token_xyz12345',
    title: 'Test title',
    body: 'Test body',
  };

  // ── 1. Successful send ──────────────────────────────────────────────────

  it('returns accepted:true with the FCM message ID on success', async () => {
    const { app } = makeApp({ messageId: 'projects/proj/messages/msg-001' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, true);
    assert.equal(result.provider, 'fcm');
    assert.equal(result.providerRef, 'projects/proj/messages/msg-001');
  });

  // ── 2. registration-token-not-registered → clears token ────────────────

  it('clears the token when FCM returns registration-token-not-registered', async () => {
    const { app } = makeApp({ errorCode: 'messaging/registration-token-not-registered' });
    const { repo, calls } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, false);
    assert.equal(result.provider, 'fcm');
    assert.equal(calls.length, 1, 'clearFcmTokenByValue must be called exactly once');
    assert.equal(calls[0], baseMessage.to);
  });

  // ── 3. invalid-registration-token → clears token ───────────────────────

  it('clears the token when FCM returns invalid-registration-token', async () => {
    const { app } = makeApp({ errorCode: 'messaging/invalid-registration-token' });
    const { repo, calls } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], baseMessage.to);
  });

  // ── 4. invalid-argument → does NOT clear token ──────────────────────────

  it('does NOT clear the token when FCM returns invalid-argument', async () => {
    // invalid-argument means a malformed payload or server-side validation
    // failure — not a stale device token. Clearing the token here would
    // silently unregister a reachable device.
    const { app } = makeApp({ errorCode: 'messaging/invalid-argument' });
    const { repo, calls } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, false);
    assert.equal(calls.length, 0, 'clearFcmTokenByValue must NOT be called for invalid-argument');
  });

  // ── 5. Transient error → no token clear ─────────────────────────────────

  it('does NOT clear the token on a transient FCM error (quota-exceeded)', async () => {
    const { app } = makeApp({ errorCode: 'messaging/quota-exceeded' });
    const { repo, calls } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, false);
    assert.equal(calls.length, 0);
  });

  // ── 6. Unknown error code → no token clear ───────────────────────────────

  it('does NOT clear the token for an unknown FCM error code', async () => {
    const { app } = makeApp({ errorCode: 'messaging/some-unknown-error' });
    const { repo, calls } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush(baseMessage);

    assert.equal(result.accepted, false);
    assert.equal(calls.length, 0);
  });

  // ── 7. APNs payload is present ───────────────────────────────────────────

  it('includes APNs alert payload for iOS', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-apns' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    await provider.sendPush(baseMessage);

    const msg = capturedMessage() as {
      apns?: { payload?: { aps?: { alert?: { title?: string; body?: string } } } };
    };
    assert.ok(msg.apns, 'apns block must be present');
    assert.equal(msg.apns?.payload?.aps?.alert?.title, baseMessage.title);
    assert.equal(msg.apns?.payload?.aps?.alert?.body, baseMessage.body);
  });

  // ── 8. Android priority is high ──────────────────────────────────────────

  it('sets android priority to high', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-android' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    await provider.sendPush(baseMessage);

    const msg = capturedMessage() as { android?: { priority?: string } };
    assert.ok(msg.android, 'android block must be present');
    assert.equal(msg.android?.priority, 'high');
  });

  // ── 9. DB error during token clear is non-fatal ──────────────────────────

  it('returns accepted:false even when clearFcmTokenByValue throws', async () => {
    const { app } = makeApp({ errorCode: 'messaging/registration-token-not-registered' });
    const { repo } = makeDeviceRepo({ shouldThrow: true });
    const provider = new FcmPushProvider(app as never, repo as never);

    // Must not propagate the DB error to the caller.
    const result = await provider.sendPush(baseMessage);
    assert.equal(result.accepted, false);
  });

  // ── 10. PA-4: presentation hints reach the Android block ─────────────────

  it('sets android channelId and sound when supplied', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-chan' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    await provider.sendPush({ ...baseMessage, channelId: 'ride-offer', sound: 'offer.wav' });

    const msg = capturedMessage() as {
      android?: { notification?: { channelId?: string; sound?: string } };
    };
    assert.equal(msg.android?.notification?.channelId, 'ride-offer');
    assert.equal(msg.android?.notification?.sound, 'offer.wav');
  });

  // ── 11. PA-5: TTL reaches both transports, in each one's own units ───────

  it('maps ttlMs to android.ttl (ms) and apns-expiration (absolute unix seconds)', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-ttl' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const before = Math.floor(Date.now() / 1000);
    await provider.sendPush({ ...baseMessage, ttlMs: 45_000 });
    const after = Math.floor(Date.now() / 1000);

    const msg = capturedMessage() as {
      android?: { ttl?: number };
      apns?: { headers?: Record<string, string> };
    };
    assert.equal(msg.android?.ttl, 45_000, 'android.ttl is a duration in milliseconds');

    const expiration = Number(msg.apns?.headers?.['apns-expiration']);
    assert.ok(
      expiration >= before + 45 && expiration <= after + 45,
      `apns-expiration must be an absolute instant ~45s out, got ${expiration}`,
    );
  });

  // ── 12. Collapse key reaches both transports ─────────────────────────────

  it('maps collapseKey to android.collapseKey and apns-collapse-id', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-collapse' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    await provider.sendPush({ ...baseMessage, collapseKey: 'ride:r-1:status' });

    const msg = capturedMessage() as {
      android?: { collapseKey?: string };
      apns?: { headers?: Record<string, string> };
    };
    assert.equal(msg.android?.collapseKey, 'ride:r-1:status');
    assert.equal(msg.apns?.headers?.['apns-collapse-id'], 'ride:r-1:status');
  });

  // ── 13. Omitting the hints reproduces the pre-PA-4 message exactly ───────

  it('omits ttl, collapseKey and android.notification when not supplied', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'msg-bare' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    await provider.sendPush(baseMessage);

    const msg = capturedMessage() as {
      android?: Record<string, unknown>;
      apns?: { headers?: Record<string, string> };
    };
    assert.deepEqual(
      Object.keys(msg.android ?? {}).sort(),
      ['priority'],
      'android block must carry nothing beyond priority when no hints are given',
    );
    assert.deepEqual(
      Object.keys(msg.apns?.headers ?? {}).sort(),
      ['apns-priority', 'apns-push-type'],
      'apns headers must be unchanged from the pre-PA-4 set',
    );
  });

  // ── 14. The anti-throttling invariant ────────────────────────────────────

  it('always sends a notification block, whatever else is set', async () => {
    // Firebase throttles high-priority messages that produce no user-visible
    // notification. `android.priority: 'high'` is only safe while this holds.
    for (const extra of [
      {},
      { channelId: 'ride' },
      { ttlMs: 1000 },
      { collapseKey: 'k' },
      { data: { a: 'b' } },
    ]) {
      const { app, capturedMessage } = makeApp({ messageId: 'msg-inv' });
      const { repo } = makeDeviceRepo();
      const provider = new FcmPushProvider(app as never, repo as never);

      await provider.sendPush({ ...baseMessage, ...extra });

      const msg = capturedMessage() as { notification?: { title?: string; body?: string } };
      assert.ok(msg.notification, `notification block missing for ${JSON.stringify(extra)}`);
      assert.equal(msg.notification?.title, baseMessage.title);
      assert.equal(msg.notification?.body, baseMessage.body);
    }
  });

  // ── 15. Size guard refuses rather than letting FCM reject ────────────────

  it('refuses an over-budget data payload without calling FCM', async () => {
    const { app, capturedMessage } = makeApp({ messageId: 'never' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    const result = await provider.sendPush({
      ...baseMessage,
      data: { blob: 'x'.repeat(5000) },
    });

    assert.equal(result.accepted, false);
    assert.equal(result.error, PAYLOAD_TOO_LARGE);
    assert.equal(capturedMessage(), undefined, 'FCM must not be called at all');
  });

  it('accepts a payload just under the budget', async () => {
    const { app } = makeApp({ messageId: 'msg-under' });
    const { repo } = makeDeviceRepo();
    const provider = new FcmPushProvider(app as never, repo as never);

    // {"blob":"xxx…"} — 11 bytes of envelope plus the run of x's.
    const result = await provider.sendPush({
      ...baseMessage,
      data: { blob: 'x'.repeat(4000) },
    });

    assert.equal(result.accepted, true);
  });
});
