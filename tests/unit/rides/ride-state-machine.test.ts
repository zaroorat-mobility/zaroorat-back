import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { InvalidRideStateTransitionError } from '../../../src/modules/rides/errors/ride.errors.js';

describe('Ride State Machine Tests', () => {
  const service = new LifecycleService(
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
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('allows valid ride state transitions', () => {
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'DRIVER_ARRIVED'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVED', 'IN_PROGRESS'));
    assert.doesNotThrow(() => service.validateTransition('IN_PROGRESS', 'COMPLETED'));
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'CANCELLED_BY_CUSTOMER'));
  });

  it('rejects illegal ride state transitions', () => {
    assert.throws(
      () => service.validateTransition('COMPLETED', 'ACCEPTED'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'ACCEPTED'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('CANCELLED_BY_CUSTOMER', 'COMPLETED'),
      InvalidRideStateTransitionError,
    );
  });
});
