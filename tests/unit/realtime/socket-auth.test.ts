import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SocketAuthService,
  tokenFromHandshake,
} from '../../../src/modules/realtime/socket-auth.service.js';

const CLAIMS = { sub: 'user_1', sid: 'sess_1', roles: ['customer'], epoch: 1 };

function makeService(
  overrides: {
    verify?: () => typeof CLAIMS;
    epoch?: number;
    revoked?: boolean;
    operable?: boolean;
    driverId?: string | null;
    roles?: string[];
  } = {},
) {
  const claims = { ...CLAIMS, roles: overrides.roles ?? CLAIMS.roles };
  return new SocketAuthService(
    {
      verify:
        overrides.verify ??
        (() => {
          return claims;
        }),
    } as never,
    {
      async current() {
        return overrides.epoch ?? 1;
      },
    } as never,
    {
      sidBlacklist: {
        async isRevoked() {
          return overrides.revoked ?? false;
        },
      },
    } as never,
    {
      async isOperableDriver() {
        return overrides.operable ?? true;
      },
    } as never,
    {
      async findByUserId() {
        return overrides.driverId === null ? null : { id: overrides.driverId ?? 'drv_1' };
      },
    } as never,
  );
}

describe('Socket handshake authentication', () => {
  describe('token extraction', () => {
    it('reads the token socket.io sends out of band', () => {
      assert.equal(tokenFromHandshake({ auth: { token: 'abc' } }), 'abc');
    });

    it('accepts an Authorization header for parity with the HTTP API', () => {
      assert.equal(tokenFromHandshake({ headers: { authorization: 'Bearer xyz' } }), 'xyz');
    });

    it('refuses a handshake with no token', () => {
      assert.throws(
        () => tokenFromHandshake({}),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });

    it('never reads a token from the query string', () => {
      // Tokens in URLs land in proxy and access logs; this must not be a way in.
      assert.throws(
        () => tokenFromHandshake({ query: { token: 'leaky' } }),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });

    it('refuses a malformed Authorization header', () => {
      assert.throws(() => tokenFromHandshake({ headers: { authorization: 'Basic abc' } }));
      assert.throws(() => tokenFromHandshake({ headers: { authorization: 'Bearer ' } }));
    });
  });

  describe('the same four checks the HTTP guard runs', () => {
    it('resolves a principal from the signed token', async () => {
      const principal = await makeService().authenticate({ auth: { token: 't' } });
      assert.equal(principal.userId, 'user_1');
      assert.equal(principal.sid, 'sess_1');
      assert.equal(principal.driverId, null, 'a customer holds no driver identity');
    });

    it('refuses an invalid or expired token', async () => {
      const service = makeService({
        verify: () => {
          throw new Error('expired');
        },
      });
      await assert.rejects(
        () => service.authenticate({ auth: { token: 't' } }),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });

    it('refuses a stale token whose epoch has been bumped', async () => {
      await assert.rejects(
        () => makeService({ epoch: 2 }).authenticate({ auth: { token: 't' } }),
        (err: unknown) => (err as Error).message.includes('stale'),
      );
    });

    it('refuses a revoked session', async () => {
      await assert.rejects(
        () => makeService({ revoked: true }).authenticate({ auth: { token: 't' } }),
        (err: unknown) => (err as Error).message.includes('revoked'),
      );
    });

    it('fails closed when the revocation store is unreachable', async () => {
      const service = new SocketAuthService(
        { verify: () => CLAIMS } as never,
        {
          async current() {
            throw new Error('redis down');
          },
        } as never,
        {
          sidBlacklist: {
            async isRevoked() {
              return false;
            },
          },
        } as never,
        {
          async isOperableDriver() {
            return false;
          },
        } as never,
        {
          async findByUserId() {
            return null;
          },
        } as never,
      );
      await assert.rejects(
        () => service.authenticate({ auth: { token: 't' } }),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });
  });

  describe('driver identity', () => {
    it('resolves a driver id server-side, never from the client', async () => {
      const principal = await makeService({ roles: ['driver'] }).authenticate({
        auth: { token: 't', driverId: 'drv_someone_else' },
      });
      assert.equal(
        principal.driverId,
        'drv_1',
        'the id comes from the token’s user, not the payload',
      );
    });

    it('gives a suspended driver a socket but no driver identity', async () => {
      const principal = await makeService({ roles: ['driver'], operable: false }).authenticate({
        auth: { token: 't' },
      });
      assert.equal(
        principal.driverId,
        null,
        'so every driver-only action on this socket is refused',
      );
    });

    it('gives no driver identity to a user without the driver role', async () => {
      const principal = await makeService({ roles: ['customer'] }).authenticate({
        auth: { token: 't' },
      });
      assert.equal(principal.driverId, null);
    });
  });
});
