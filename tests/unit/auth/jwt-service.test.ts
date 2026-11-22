import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { JwtService } from '../../../src/modules/auth/services/token/jwt.service.js';
import { TokenInvalidError } from '../../../src/modules/auth/errors/auth.errors.js';
import { makeJwtConfig } from '../../helpers/config.js';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const sign = (secret: string, signingInput: string): string =>
  createHmac('sha256', secret).update(signingInput).digest('base64url');

describe('JwtService', () => {
  const config = makeJwtConfig({ issuer: 'zaroorat-test', accessTtlSeconds: 900 });
  const service = new JwtService(config);

  const input = { userId: 'u1', sessionId: 's1', roles: ['customer'], epoch: 3 };

  it('round-trips: a freshly signed token verifies and returns its claims', () => {
    const token = service.sign(input);
    const claims = service.verify(token);

    assert.equal(claims.sub, 'u1');
    assert.equal(claims.sid, 's1');
    assert.deepEqual(claims.roles, ['customer']);
    assert.equal(claims.epoch, 3);
    assert.equal(claims.iss, 'zaroorat-test');
    assert.equal(typeof claims.jti, 'string');
    assert.ok(claims.exp > claims.iat);
  });

  it('rejects a non-three-part token', () => {
    assert.throws(() => service.verify('not.a.jwt.at.all'), TokenInvalidError);
    assert.throws(() => service.verify('onlyonepart'), TokenInvalidError);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const [header, , signature] = service.sign(input).split('.');
    const forgedPayload = b64url({ sub: 'attacker', sid: 's1', epoch: 999, iss: 'zaroorat-test' });
    assert.throws(
      () => service.verify(`${header}.${forgedPayload}.${signature}`),
      TokenInvalidError,
    );
  });

  it('rejects a token signed with the wrong secret', () => {
    const attacker = new JwtService(makeJwtConfig({ accessSecret: 'attacker-secret' }));
    const forged = attacker.sign(input);
    assert.throws(() => service.verify(forged), TokenInvalidError);
  });

  it('pins alg=HS256 — a validly-HMACd token with alg "none" is rejected (no confusion)', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({
      sub: 'u1',
      sid: 's1',
      roles: [],
      epoch: 1,
      jti: 'x',
      iat: now,
      exp: now + 900,
      iss: 'zaroorat-test',
    });

    const token = `${header}.${payload}.${sign(config.accessSecret, `${header}.${payload}`)}`;
    assert.throws(() => service.verify(token), TokenInvalidError);
  });

  it('rejects an expired token (exp in the past)', () => {
    const expiring = new JwtService(
      makeJwtConfig({ accessTtlSeconds: -10, issuer: 'zaroorat-test' }),
    );
    const token = expiring.sign(input);
    assert.throws(() => service.verify(token), /expired/i);
  });

  it('rejects a token from a different issuer', () => {
    const other = new JwtService(
      makeJwtConfig({ issuer: 'someone-else', accessSecret: config.accessSecret }),
    );
    const token = other.sign(input);
    assert.throws(() => service.verify(token), TokenInvalidError);
  });

  it('supports zero-downtime key rotation using kid', () => {
    const oldConfig = makeJwtConfig({ primaryKid: 'v1', accessSecret: 'secret-v1' });
    const oldService = new JwtService(oldConfig);
    const tokenV1 = oldService.sign(input);

    const newConfig = makeJwtConfig({
      primaryKid: 'v2',
      accessSecret: 'secret-v2',
      accessSecrets: {
        v1: 'secret-v1',
        v2: 'secret-v2',
      },
    });
    const newService = new JwtService(newConfig);

    const claimsV1 = newService.verify(tokenV1);
    assert.equal(claimsV1.sub, 'u1');

    const tokenV2 = newService.sign(input);
    const claimsV2 = newService.verify(tokenV2);
    assert.equal(claimsV2.sub, 'u1');
  });
});
