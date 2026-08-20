import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import { InvalidStateTransitionError } from '../../../src/modules/payments/errors/payment.errors.js';

describe('Payment State Machine Tests', () => {
  const service = new IntentService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('allows valid state transitions', () => {
    assert.doesNotThrow(() => service.validateTransition('CREATED', 'PENDING'));
    assert.doesNotThrow(() => service.validateTransition('PENDING', 'PROCESSING'));
    assert.doesNotThrow(() => service.validateTransition('PROCESSING', 'SUCCEEDED'));
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
