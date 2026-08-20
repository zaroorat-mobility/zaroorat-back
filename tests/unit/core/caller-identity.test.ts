import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';

import {
  assertOwnerOrStaff,
  assertRideParty,
  callerHasRole,
  callerId,
  ForbiddenResourceError,
  requireCaller,
  UnauthenticatedError,
} from '../../../src/core/auth/caller.js';

function req(auth: { userId: string; sid?: string; roles?: string[] } | null): FastifyRequest {
  return {
    auth: auth ? { sid: 'sid-1', roles: [], ...auth } : null,
  } as unknown as FastifyRequest;
}

describe('Caller identity', () => {
  it('returns the authenticated caller', () => {
    assert.equal(callerId(req({ userId: 'user-1' })), 'user-1');
    assert.equal(requireCaller(req({ userId: 'user-1' })).userId, 'user-1');
  });

  it('throws rather than defaulting when unauthenticated', () => {
    assert.throws(
      () => callerId(req(null)),
      (err: unknown) => err instanceof UnauthenticatedError,
    );
  });

  it('reports roles from the token only', () => {
    const driver = req({ userId: 'user-1', roles: ['driver'] });
    assert.equal(callerHasRole(driver, 'driver'), true);
    assert.equal(callerHasRole(driver, 'admin'), false);
    assert.equal(callerHasRole(req(null), 'driver'), false);
  });
});

describe('assertOwnerOrStaff', () => {
  it('permits the owner', () => {
    assert.doesNotThrow(() => assertOwnerOrStaff(req({ userId: 'user-1' }), 'user-1'));
  });

  it('refuses a different user', () => {
    assert.throws(
      () => assertOwnerOrStaff(req({ userId: 'attacker' }), 'user-1'),
      (err: unknown) => err instanceof ForbiddenResourceError,
    );
  });

  it('permits staff', () => {
    assert.doesNotThrow(() =>
      assertOwnerOrStaff(req({ userId: 'ops', roles: ['support'] }), 'user-1'),
    );
  });

  it('refuses when the record has no owner, rather than defaulting open', () => {
    for (const owner of [null, undefined, '']) {
      assert.throws(
        () => assertOwnerOrStaff(req({ userId: 'user-1' }), owner),
        (err: unknown) => err instanceof ForbiddenResourceError,
      );
    }
  });
});

describe('assertRideParty', () => {
  const ride = { customerId: 'cust-1', driverUserId: 'driver-user-1' };

  it('permits the customer and the assigned driver', () => {
    assert.doesNotThrow(() => assertRideParty(req({ userId: 'cust-1' }), ride));
    assert.doesNotThrow(() => assertRideParty(req({ userId: 'driver-user-1' }), ride));
  });

  it('refuses an unrelated user', () => {
    assert.throws(
      () => assertRideParty(req({ userId: 'stranger' }), ride),
      (err: unknown) => err instanceof ForbiddenResourceError,
    );
  });

  it('refuses a driver who is not the one assigned', () => {
    assert.throws(
      () => assertRideParty(req({ userId: 'other-driver' }), ride),
      (err: unknown) => err instanceof ForbiddenResourceError,
    );
  });

  it('does not treat an unassigned ride as readable by anyone', () => {
    assert.throws(
      () =>
        assertRideParty(req({ userId: 'stranger' }), { customerId: 'cust-1', driverUserId: null }),
      (err: unknown) => err instanceof ForbiddenResourceError,
    );
  });

  it('permits staff', () => {
    assert.doesNotThrow(() => assertRideParty(req({ userId: 'ops', roles: ['admin'] }), ride));
  });
});

describe('No controller derives identity from the request payload', () => {
  const CONTROLLERS = join(process.cwd(), 'src', 'modules');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.controller.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(CONTROLLERS);

  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('found the controllers', () => {
    assert.ok(files.length > 10, `expected many controllers, found ${files.length}`);
  });

  it('strips comments before scanning', () => {
    const sample = files.find((f) => f.endsWith('ride-query.controller.ts'));
    assert.ok(sample);
    assert.doesNotMatch(code(sample), /req as any/);
  });

  it('never reads `req.user` — the property does not exist', () => {
    const offenders = files.filter((file) =>
      /\(\s*req(uest)?\s+as\s+any\s*\)\s*\.\s*user\b/.test(code(file)),
    );
    assert.deepEqual(
      offenders.map((f) => f.replace(process.cwd(), '.')),
      [],
      'these controllers read a `user` property the auth plugin never sets, so the value ' +
        'is always undefined and the `??` fallback beside it decides the caller',
    );
  });

  it('never falls back to a body/param/query id for identity', () => {
    const FALLBACK =
      /\?\?\s*\(?\s*req(uest)?\s*(as\s+any)?\s*\)?\s*\.\s*(body|params|query)[^;\n]*\b(userId|customerId|driverId)\b/;

    const offenders = files.filter((file) => FALLBACK.test(code(file)));
    assert.deepEqual(
      offenders.map((f) => f.replace(process.cwd(), '.')),
      [],
      'identity must come from the token; a `?? req.body.userId` fallback lets the caller ' +
        'choose who they are',
    );
  });

  it('never falls back to a hardcoded actor', () => {
    const offenders = files.filter((file) =>
      /\?\?\s*'(driver|system|admin|user)'/.test(code(file)),
    );
    assert.deepEqual(
      offenders.map((f) => f.replace(process.cwd(), '.')),
      [],
    );
  });
});
