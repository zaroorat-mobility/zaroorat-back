import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import { IntentController } from '../../../src/modules/payments/controllers/intent.controller.js';
import { PaymentNotFoundError } from '../../../src/modules/payments/errors/payment.errors.js';
import { UnauthenticatedError } from '../../../src/core/auth/caller.js';
import { intentIdParams } from '../../../src/modules/payments/routes/payment.routes.js';
import { handlePaymentError } from '../../../src/modules/payments/schemas/error-response.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';

/// 005-razorpay-driver-payments T027 (TM-16, CD-15): `POST /payments/intents/
/// :intentId/confirm` must answer someone else's intent exactly like a missing
/// one, so it cannot reveal which intent ids exist (spec.md SEC-2).

const OWNER = 'user_owner';
const EXISTING_ID = '0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a11';
const MISSING_ID = '0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a99';

function harness() {
  const confirmed: string[] = [];
  const intent = {
    id: EXISTING_ID,
    userId: OWNER,
    rideId: null,
    amount: new Decimal(500),
    currency: 'INR',
    status: 'PENDING',
    gateway: 'mock',
    gatewayIntentId: 'order_1',
    createdAt: new Date('2026-10-19T00:00:00Z'),
  };
  const paymentService = {
    intent: {
      async findById(id: string) {
        return id === EXISTING_ID ? intent : null;
      },
      async confirmIntent(id: string) {
        confirmed.push(id);
        return intent;
      },
    },
    async withIdempotency<T>(
      _u: string,
      _r: string,
      _k: string | undefined,
      _p: unknown,
      op: () => Promise<T>,
    ) {
      return op();
    },
  };
  const controller = new IntentController(paymentService as never);
  const call = async (intentId: string, auth: { userId: string; roles: string[] } | undefined) => {
    let sent: unknown;
    await controller.confirmIntent(
      {
        params: { intentId },
        headers: { 'idempotency-key': 'k1' },
        auth: auth && { ...auth, sid: 's1' },
      } as never,
      {
        send(body: unknown) {
          sent = body;
        },
      } as never,
    );
    return sent;
  };
  return { call, confirmed };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('POST /payments/intents/:intentId/confirm — ownership (T027)', () => {
  it("answers another user's intent exactly like a missing one", async () => {
    const h = harness();
    const stranger = { userId: 'user_stranger', roles: ['driver'] };

    const foreign = await rejection(h.call(EXISTING_ID, stranger));
    const missing = await rejection(h.call(EXISTING_ID.replace('11', '99'), stranger));

    assert.ok(foreign instanceof PaymentNotFoundError);
    assert.ok(missing instanceof PaymentNotFoundError);
    const shape = (e: Error) => {
      const coded = e as PaymentNotFoundError;
      return { name: coded.name, code: coded.code, status: coded.statusCode };
    };
    assert.deepEqual(shape(foreign), shape(missing));
    assert.equal((foreign as PaymentNotFoundError).statusCode, 404);
    // The message names only the id the caller sent, which they already know.
    assert.equal(foreign.message, new PaymentNotFoundError(EXISTING_ID).message);
    assert.deepEqual(h.confirmed, []);
  });

  it('still confirms for the owner', async () => {
    const h = harness();
    const body = (await h.call(EXISTING_ID, { userId: OWNER, roles: ['driver'] })) as {
      data: { id: string };
    };
    assert.equal(body.data.id, EXISTING_ID);
    assert.deepEqual(h.confirmed, [EXISTING_ID]);
  });

  it('still confirms for staff', async () => {
    const h = harness();
    await h.call(EXISTING_ID, { userId: 'user_support', roles: ['support'] });
    assert.deepEqual(h.confirmed, [EXISTING_ID]);
  });

  it('still answers 401 to an unauthenticated caller', async () => {
    const h = harness();
    const err = await rejection(h.call(EXISTING_ID, undefined));
    assert.ok(err instanceof UnauthenticatedError);
  });

  it('answers 404 for a missing intent, as before', async () => {
    const h = harness();
    const err = await rejection(h.call(MISSING_ID, { userId: OWNER, roles: ['driver'] }));
    assert.ok(err instanceof PaymentNotFoundError);
  });
});

describe('POST /payments/intents/:intentId/confirm — UUID param (T027)', () => {
  async function app() {
    const fastify = Fastify();
    fastify.setErrorHandler(handlePaymentError);
    let reached = 0;
    fastify.post('/intents/:intentId/confirm', { schema: { params: intentIdParams } }, async () => {
      reached += 1;
      return { ok: true };
    });
    await fastify.ready();
    return { fastify, reached: () => reached };
  }

  it('rejects a non-UUID id with 400 before the handler runs', async () => {
    const { fastify, reached } = await app();
    const res = await fastify.inject({ method: 'POST', url: '/intents/not-a-uuid/confirm' });
    assert.equal(res.statusCode, 400);
    assert.equal(reached(), 0);
    await fastify.close();
  });

  it('lets a UUID through to the handler', async () => {
    const { fastify, reached } = await app();
    const res = await fastify.inject({ method: 'POST', url: `/intents/${EXISTING_ID}/confirm` });
    assert.equal(res.statusCode, 200);
    assert.equal(reached(), 1);
    await fastify.close();
  });
});
