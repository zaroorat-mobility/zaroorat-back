import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService } from '../../../src/modules/auth/services/auth.service.js';

/// PA-7 — logout releases the device's push token, and cannot be prevented from
/// logging the user out by failing to do so.
///
/// Decision D-1: `AuthService` owns this because it already holds both
/// `sessionService` and `deviceService`. `SessionService` gains no device
/// dependency, and these tests assert that boundary directly.
///
/// The ordering matters and is asserted: revocation is the security-critical step
/// and runs unconditionally; cleanup runs after and is isolated.

interface Harness {
  service: AuthService;
  calls: string[];
  clearedDevices: string[];
  clearedUsers: string[];
  deviceServiceKeys: string[];
}

function makeAuthService(
  opts: {
    sessionDeviceId?: string | null;
    failOn?: 'deviceIdFor' | 'clearDevice' | 'clearUser' | 'logout' | 'logoutAll';
    clearedCount?: number;
  } = {},
): Harness {
  const calls: string[] = [];
  const clearedDevices: string[] = [];
  const clearedUsers: string[] = [];

  const sessionService = {
    async deviceIdFor(_sessionId: string) {
      calls.push('deviceIdFor');
      if (opts.failOn === 'deviceIdFor') throw new Error('session lookup failed');
      return opts.sessionDeviceId === undefined ? 'dev-1' : opts.sessionDeviceId;
    },
    async logout(_sessionId: string) {
      calls.push('logout');
      if (opts.failOn === 'logout') throw new Error('session revocation failed');
    },
    async logoutAll(_userId: string) {
      calls.push('logoutAll');
      if (opts.failOn === 'logoutAll') throw new Error('logoutAll failed');
    },
  };

  const deviceService = {
    async clearPushTokenForDevice(deviceId: string) {
      calls.push('clearPushTokenForDevice');
      if (opts.failOn === 'clearDevice') throw new Error('device token clear failed');
      clearedDevices.push(deviceId);
      return opts.clearedCount ?? 1;
    },
    async clearPushTokensForUser(userId: string) {
      calls.push('clearPushTokensForUser');
      if (opts.failOn === 'clearUser') throw new Error('user token clear failed');
      clearedUsers.push(userId);
      return opts.clearedCount ?? 3;
    },
  };

  const service = new AuthService(
    {} as never, // otpService
    {} as never, // userRepository
    {} as never, // userProfileRepository
    {} as never, // roleRepository
    {} as never, // permissionRepository
    deviceService as never,
    sessionService as never,
    {} as never, // tokenService
    {} as never, // epochService
    {} as never, // redisService
    {} as never, // eventPublisher
    {} as never, // transactionManager
    {} as never, // jwtConfig
    {} as never, // sessionConfig
  );

  return {
    service,
    calls,
    clearedDevices,
    clearedUsers,
    deviceServiceKeys: Object.keys(deviceService),
  };
}

// ── A. logout clears the session's device token ────────────────────────────

describe('PA-7 · A · logout clears the device token', () => {
  it('clears the token for the device the session was bound to', async () => {
    const { service, clearedDevices } = makeAuthService({ sessionDeviceId: 'dev-42' });

    await service.logout('sess-1');

    assert.deepEqual(clearedDevices, ['dev-42']);
  });

  it('revokes the session before attempting cleanup', async () => {
    // Revocation is the security-critical step; cleanup is housekeeping that
    // follows it. Reversing this would let a cleanup failure delay a logout.
    const { service, calls } = makeAuthService({ sessionDeviceId: 'dev-42' });

    await service.logout('sess-1');

    assert.ok(
      calls.indexOf('logout') < calls.indexOf('clearPushTokenForDevice'),
      `revocation must precede cleanup, got ${calls.join(' → ')}`,
    );
  });

  it('resolves the device id before revoking, not after', async () => {
    // So PA-7 does not depend on the session row surviving revocation — an
    // implementation detail of sessionRepository.revoke that could change.
    const { service, calls } = makeAuthService({ sessionDeviceId: 'dev-42' });

    await service.logout('sess-1');

    assert.deepEqual(calls, ['deviceIdFor', 'logout', 'clearPushTokenForDevice']);
  });

  it('still revokes the session when it is bound to no device', async () => {
    const { service, calls, clearedDevices } = makeAuthService({ sessionDeviceId: null });

    await service.logout('sess-1');

    assert.ok(calls.includes('logout'), 'the session must still be revoked');
    assert.deepEqual(clearedDevices, [], 'nothing to clear, and no attempt made');
    assert.ok(!calls.includes('clearPushTokenForDevice'));
  });
});

// ── B. logoutAll clears every device the user holds ────────────────────────

describe('PA-7 · B · logoutAll clears every device token', () => {
  it('clears tokens for the whole user, not just one device', async () => {
    const { service, clearedUsers } = makeAuthService({});

    await service.logoutAll('usr-7');

    assert.deepEqual(clearedUsers, ['usr-7']);
  });

  it('revokes all sessions before attempting cleanup', async () => {
    const { service, calls } = makeAuthService({});

    await service.logoutAll('usr-7');

    assert.deepEqual(calls, ['logoutAll', 'clearPushTokensForUser']);
  });

  it('does not resolve a session device — logoutAll is not session-scoped', async () => {
    const { service, calls } = makeAuthService({});

    await service.logoutAll('usr-7');

    assert.ok(!calls.includes('deviceIdFor'));
  });
});

// ── C. Revocation succeeds when cleanup succeeds ───────────────────────────

describe('PA-7 · C · revocation succeeds on the happy path', () => {
  it('logout resolves without error and performs both steps', async () => {
    const { service, calls } = makeAuthService({ sessionDeviceId: 'dev-1' });

    await assert.doesNotReject(() => service.logout('sess-1'));
    assert.ok(calls.includes('logout') && calls.includes('clearPushTokenForDevice'));
  });

  it('logoutAll resolves without error and performs both steps', async () => {
    const { service, calls } = makeAuthService({});

    await assert.doesNotReject(() => service.logoutAll('usr-7'));
    assert.ok(calls.includes('logoutAll') && calls.includes('clearPushTokensForUser'));
  });
});

// ── D + F. Cleanup failure must not fail the logout ────────────────────────

describe('PA-7 · D and F · cleanup failure does not fail the logout', () => {
  it('logout still succeeds when clearing the device token throws', async () => {
    const { service, calls } = makeAuthService({
      sessionDeviceId: 'dev-1',
      failOn: 'clearDevice',
    });

    // A user who asked to be logged out is logged out, full stop.
    await assert.doesNotReject(() => service.logout('sess-1'));
    assert.ok(calls.includes('logout'), 'the session was still revoked');
    assert.ok(calls.includes('clearPushTokenForDevice'), 'cleanup was attempted');
  });

  it('logoutAll still succeeds when clearing the user tokens throws', async () => {
    const { service, calls } = makeAuthService({ failOn: 'clearUser' });

    await assert.doesNotReject(() => service.logoutAll('usr-7'));
    assert.ok(calls.includes('logoutAll'));
    assert.ok(calls.includes('clearPushTokensForUser'));
  });

  it('logout still succeeds when the device lookup itself throws', async () => {
    // The lookup happens before revocation, so it is isolated too — otherwise it
    // would sit between the user and being logged out.
    const { service, calls, clearedDevices } = makeAuthService({ failOn: 'deviceIdFor' });

    await assert.doesNotReject(() => service.logout('sess-1'));
    assert.ok(calls.includes('logout'), 'revocation must still happen');
    assert.deepEqual(clearedDevices, [], 'no device could be resolved, so none was cleared');
  });

  it('a genuine revocation failure is NOT swallowed', async () => {
    // The isolation is one-directional. Failing to revoke a session is a real
    // failure and the caller must hear about it.
    const { service } = makeAuthService({ sessionDeviceId: 'dev-1', failOn: 'logout' });

    await assert.rejects(() => service.logout('sess-1'), /session revocation failed/);
  });

  it('a genuine logoutAll failure is NOT swallowed', async () => {
    const { service } = makeAuthService({ failOn: 'logoutAll' });

    await assert.rejects(() => service.logoutAll('usr-7'), /logoutAll failed/);
  });

  it('does not attempt cleanup when revocation failed', async () => {
    const { service, calls } = makeAuthService({ sessionDeviceId: 'dev-1', failOn: 'logout' });

    await assert.rejects(() => service.logout('sess-1'));
    assert.ok(
      !calls.includes('clearPushTokenForDevice'),
      'cleanup is pointless if the session survived',
    );
  });
});

// ── E. Cleanup failure is observable ───────────────────────────────────────

describe('PA-7 · E · cleanup failure is observable', () => {
  /// Captures what the shared pino logger is asked to write. The logger is a
  /// module singleton, so this patches its methods for the duration of the call
  /// rather than injecting one.
  async function captureLogs(run: () => Promise<void>): Promise<{
    errors: Array<{ ctx: Record<string, unknown>; msg: string }>;
    infos: Array<{ ctx: Record<string, unknown>; msg: string }>;
  }> {
    const { logger } = await import('../../../src/shared/logger/index.js');
    const errors: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
    const infos: Array<{ ctx: Record<string, unknown>; msg: string }> = [];

    const realError = logger.error.bind(logger);
    const realInfo = logger.info.bind(logger);
    (logger as unknown as Record<string, unknown>).error = (
      ctx: Record<string, unknown>,
      msg: string,
    ): void => {
      errors.push({ ctx, msg });
    };
    (logger as unknown as Record<string, unknown>).info = (
      ctx: Record<string, unknown>,
      msg: string,
    ): void => {
      infos.push({ ctx, msg });
    };

    try {
      await run();
    } finally {
      (logger as unknown as Record<string, unknown>).error = realError;
      (logger as unknown as Record<string, unknown>).info = realInfo;
    }
    return { errors, infos };
  }

  it('logs the device-clear failure at error level with the device context', async () => {
    const { service } = makeAuthService({ sessionDeviceId: 'dev-9', failOn: 'clearDevice' });

    const { errors } = await captureLogs(() => service.logout('sess-1'));

    const hit = errors.find((e) => /clearing the device push token failed/i.test(e.msg));
    assert.ok(hit, `expected an error log, got: ${errors.map((e) => e.msg).join(' | ')}`);
    assert.equal(hit?.ctx.deviceId, 'dev-9');
    assert.equal(hit?.ctx.sessionId, 'sess-1');
    assert.ok(hit?.ctx.err, 'the underlying error must be attached');
    // The message must say what the residue is, not just that something failed.
    assert.match(hit?.msg ?? '', /may still receive notifications/i);
  });

  it('logs the user-wide clear failure at error level', async () => {
    const { service } = makeAuthService({ failOn: 'clearUser' });

    const { errors } = await captureLogs(() => service.logoutAll('usr-7'));

    const hit = errors.find((e) => /clearing the device push token failed/i.test(e.msg));
    assert.ok(hit);
    assert.equal(hit?.ctx.userId, 'usr-7');
  });

  it('logs the failed session lookup at error level', async () => {
    const { service } = makeAuthService({ failOn: 'deviceIdFor' });

    const { errors } = await captureLogs(() => service.logout('sess-1'));

    assert.ok(errors.some((e) => /could not resolve the session device/i.test(e.msg)));
  });

  it('records a successful clear too, so the normal path is observable', async () => {
    const { service } = makeAuthService({ sessionDeviceId: 'dev-9', clearedCount: 1 });

    const { infos } = await captureLogs(() => service.logout('sess-1'));

    const hit = infos.find((i) => /push token cleared on logout/i.test(i.msg));
    assert.ok(hit);
    assert.equal(hit?.ctx.cleared, 1);
  });

  it('stays quiet when there was no token to clear', async () => {
    // Avoids a log line per logout for the common case of an already-clean device.
    const { service } = makeAuthService({ sessionDeviceId: 'dev-9', clearedCount: 0 });

    const { infos, errors } = await captureLogs(() => service.logout('sess-1'));

    assert.equal(infos.filter((i) => /push token cleared/i.test(i.msg)).length, 0);
    assert.equal(errors.length, 0);
  });
});

// ── D-1 boundary ───────────────────────────────────────────────────────────

describe('PA-7 · the D-1 ownership boundary', () => {
  it('drives cleanup through deviceService, never through a session-service device call', async () => {
    const { service, calls, deviceServiceKeys } = makeAuthService({ sessionDeviceId: 'dev-1' });

    await service.logout('sess-1');

    // AuthService coordinates the two services; SessionService is only asked for
    // session facts (`deviceIdFor`, `logout`) and never for device mutation.
    assert.ok(deviceServiceKeys.includes('clearPushTokenForDevice'));
    assert.deepEqual(
      calls.filter((c) => c.startsWith('clear')),
      ['clearPushTokenForDevice'],
    );
  });
});
