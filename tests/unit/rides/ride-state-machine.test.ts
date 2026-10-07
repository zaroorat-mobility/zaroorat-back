import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import { InvalidRideStateTransitionError } from '../../../src/modules/rides/errors/ride.errors.js';

describe('Ride State Machine Tests', () => {
  // Every collaborator is a stub: these cases only exercise the pure
  // transition table, which touches none of them.
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
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('allows complete valid ride flow: ACCEPTED -> DRIVER_ARRIVING -> DRIVER_ARRIVED -> IN_PROGRESS -> DRIVER_AT_DROPOFF -> COMPLETED', () => {
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'DRIVER_ARRIVING'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVING', 'DRIVER_ARRIVED'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVED', 'IN_PROGRESS'));
    assert.doesNotThrow(() => service.validateTransition('IN_PROGRESS', 'DRIVER_AT_DROPOFF'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_AT_DROPOFF', 'COMPLETED'));
  });

  it('allows direct arrival jump and early-end completion', () => {
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'DRIVER_ARRIVED'));
    assert.doesNotThrow(() => service.validateTransition('IN_PROGRESS', 'COMPLETED'));
  });

  it('allows valid cancellation paths', () => {
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'CANCELLED_BY_CUSTOMER'));
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'CANCELLED_BY_DRIVER'));
    assert.doesNotThrow(() => service.validateTransition('ACCEPTED', 'CANCELLED_BY_SYSTEM'));

    assert.doesNotThrow(() =>
      service.validateTransition('DRIVER_ARRIVING', 'CANCELLED_BY_CUSTOMER'),
    );
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVING', 'CANCELLED_BY_DRIVER'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVING', 'CANCELLED_BY_SYSTEM'));

    assert.doesNotThrow(() =>
      service.validateTransition('DRIVER_ARRIVED', 'CANCELLED_BY_CUSTOMER'),
    );
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVED', 'CANCELLED_BY_DRIVER'));
    assert.doesNotThrow(() => service.validateTransition('DRIVER_ARRIVED', 'CANCELLED_BY_SYSTEM'));

    assert.doesNotThrow(() => service.validateTransition('IN_PROGRESS', 'CANCELLED_BY_SYSTEM'));
    assert.doesNotThrow(() =>
      service.validateTransition('DRIVER_AT_DROPOFF', 'CANCELLED_BY_SYSTEM'),
    );
  });

  it('rejects illegal ride state transitions', () => {
    assert.throws(
      () => service.validateTransition('ACCEPTED', 'DRIVER_AT_DROPOFF'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('ACCEPTED', 'COMPLETED'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('DRIVER_ARRIVING', 'IN_PROGRESS'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_ARRIVING', 'DRIVER_AT_DROPOFF'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_ARRIVING', 'COMPLETED'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('DRIVER_ARRIVED', 'DRIVER_AT_DROPOFF'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_ARRIVED', 'COMPLETED'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'ACCEPTED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'DRIVER_ARRIVING'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'DRIVER_ARRIVED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'CANCELLED_BY_CUSTOMER'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('IN_PROGRESS', 'CANCELLED_BY_DRIVER'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('DRIVER_AT_DROPOFF', 'IN_PROGRESS'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_AT_DROPOFF', 'DRIVER_ARRIVED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_AT_DROPOFF', 'ACCEPTED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_AT_DROPOFF', 'CANCELLED_BY_CUSTOMER'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('DRIVER_AT_DROPOFF', 'CANCELLED_BY_DRIVER'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('COMPLETED', 'ACCEPTED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('COMPLETED', 'DRIVER_AT_DROPOFF'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('COMPLETED', 'IN_PROGRESS'),
      InvalidRideStateTransitionError,
    );

    assert.throws(
      () => service.validateTransition('CANCELLED_BY_CUSTOMER', 'COMPLETED'),
      InvalidRideStateTransitionError,
    );
    assert.throws(
      () => service.validateTransition('CANCELLED_BY_CUSTOMER', 'DRIVER_AT_DROPOFF'),
      InvalidRideStateTransitionError,
    );
  });
});
