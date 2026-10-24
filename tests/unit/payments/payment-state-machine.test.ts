import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import { InvalidStateTransitionError } from '../../../src/modules/payments/errors/payment.errors.js';

describe('Payment State Machine Tests (H1)', () => {
  const service = new IntentService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('allows the data-model §2 moves into and out of MANUAL_REVIEW and EXPIRED (005 T024)', () => {
    for (const from of ['PENDING', 'PROCESSING', 'FAILED', 'EXPIRED', 'CANCELLED']) {
      assert.doesNotThrow(() => service.validateTransition(from, 'MANUAL_REVIEW'));
    }
    assert.doesNotThrow(() => service.validateTransition('EXPIRED', 'SUCCEEDED'));
    assert.doesNotThrow(() => service.validateTransition('PENDING', 'EXPIRED'));
    assert.doesNotThrow(() => service.validateTransition('MANUAL_REVIEW', 'CANCELLED'));
  });

  it('never moves SUCCEEDED into review or EXPIRED', () => {
    for (const to of ['MANUAL_REVIEW', 'EXPIRED', 'FAILED']) {
      assert.throws(() => service.validateTransition('SUCCEEDED', to), InvalidStateTransitionError);
    }
  });

  it('allows valid state transitions including late capture recovery FAILED -> SUCCEEDED', () => {
    assert.doesNotThrow(() => service.validateTransition('CREATED', 'PENDING'));
    assert.doesNotThrow(() => service.validateTransition('PENDING', 'PROCESSING'));
    assert.doesNotThrow(() => service.validateTransition('PROCESSING', 'SUCCEEDED'));
    assert.doesNotThrow(() => service.validateTransition('PENDING', 'SUCCEEDED'));
    assert.doesNotThrow(() => service.validateTransition('FAILED', 'SUCCEEDED')); // H1 late capture
    assert.doesNotThrow(() => service.validateTransition('SUCCEEDED', 'REFUND_PENDING'));
    assert.doesNotThrow(() => service.validateTransition('REFUND_PENDING', 'REFUNDED'));
  });

  it('rejects illegal state transitions', () => {
    assert.throws(
      () => service.validateTransition('REFUNDED', 'SUCCEEDED'),
      InvalidStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('FAILED', 'REFUNDED'),
      InvalidStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('CANCELLED', 'SUCCEEDED'),
      InvalidStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('REFUNDED', 'REFUND_PENDING'),
      InvalidStateTransitionError,
    );
  });
});
