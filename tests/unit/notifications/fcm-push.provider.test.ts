import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FcmPushProvider } from '../../../src/integrations/firebase/fcm-push.provider.js';
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
});
