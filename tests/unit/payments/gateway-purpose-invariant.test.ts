import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal } from '../../../src/modules/payments/types/index.js';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import {
  GATEWAY_PAYMENT_PURPOSES,
  type GatewayPaymentPurpose,
} from '../../../src/modules/payments/constants/payment.constants.js';
import {
  DuplicateIdempotencyKeyError,
  PaymentPurposeNotAllowedError,
} from '../../../src/modules/payments/errors/payment.errors.js';

/// A customer's ride fare is paid to the driver directly. The only money a
/// gateway may ever see is a driver subscription or a commission recharge.
function harness(existing: { purpose: string } | null = null) {
  const gatewayCalls: unknown[] = [];
  const created: { purpose: string }[] = [];
  const intentRepo = {
    async findByIdempotencyKey() {
      return existing;
    },
    async create(input: { purpose: string }) {
      created.push(input);
      return { id: 'intent_1', ...input };
    },
  };
  const gatewayResolver = {
    async getActiveGateway() {
      return {
        gatewayName: 'mock',
        async createIntent(input: unknown) {
          gatewayCalls.push(input);
          return { gatewayIntentId: 'mock_pi_1', status: 'PENDING' };
        },
      };
    },
  };
  const txManager = { execute: (fn: (tx: unknown) => unknown) => fn({}) };
  const eventPublisher = { async publish() {} };
  const service = new IntentService(
    intentRepo as never,
    gatewayResolver as never,
    {} as never,
    txManager as never,
    eventPublisher as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const create = (purpose: string) =>
    service.createIntent({
      userId: 'user_1',
      amount: new Decimal(100),
      methodType: 'CARD',
      idempotencyKey: 'key_1',
      purpose: purpose as GatewayPaymentPurpose,
    });
  return { create, gatewayCalls, created };
}

describe('gateway payment purpose invariant', () => {
  it('allows exactly the driver subscription and commission recharge purposes', () => {
    assert.deepEqual([...GATEWAY_PAYMENT_PURPOSES].sort(), [
      'DRIVER_COMMISSION_RECHARGE',
      'DRIVER_SUBSCRIPTION_PAYMENT',
    ]);
  });

  for (const purpose of ['CUSTOMER_WALLET_TOPUP', 'CUSTOMER_RIDE_PAYMENT', '', 'ANYTHING']) {
    it(`refuses "${purpose}" before any gateway call or intent row`, async () => {
      const h = harness();
      await assert.rejects(h.create(purpose), PaymentPurposeNotAllowedError);
      assert.equal(h.gatewayCalls.length, 0);
      assert.equal(h.created.length, 0);
    });
  }

  for (const purpose of GATEWAY_PAYMENT_PURPOSES) {
    it(`creates a ${purpose} intent through the gateway`, async () => {
      const h = harness();
      const intent = await h.create(purpose);
      assert.equal(h.gatewayCalls.length, 1);
      assert.equal((intent as unknown as { purpose: string }).purpose, purpose);
    });
  }

  it('refuses to hand back a historical customer top-up under a colliding key', async () => {
    const h = harness({ purpose: 'CUSTOMER_WALLET_TOPUP' });
    await assert.rejects(h.create('DRIVER_COMMISSION_RECHARGE'), DuplicateIdempotencyKeyError);
    assert.equal(h.gatewayCalls.length, 0);
  });

  it('replays an existing intent of the same purpose without a second gateway call', async () => {
    const h = harness({ purpose: 'DRIVER_SUBSCRIPTION_PAYMENT' });
    await h.create('DRIVER_SUBSCRIPTION_PAYMENT');
    assert.equal(h.gatewayCalls.length, 0);
  });
});
