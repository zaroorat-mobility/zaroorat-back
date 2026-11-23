import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeCancellationAssessment,
  deriveCancellationScenario,
  pickWinningCancellationPolicy,
  type CancellationPolicyRecord,
} from '../../../src/modules/pricing/services/cancellation-policy.service.js';

function makePolicy(overrides: Partial<CancellationPolicyRecord> = {}): CancellationPolicyRecord {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    ruleName: 'Rider after arrival',
    familyId: '00000000-0000-7000-8000-000000000010',
    version: 1,
    cancelledBy: 'RIDER',
    minStatus: 'AFTER_ARRIVAL',
    cityCode: null,
    vehicleTypeId: null,
    freeCancelWindowSec: 120,
    feeType: 'FLAT',
    feeAmount: 30,
    maxFee: null,
    feeBase: 'QUOTED_FARE',
    driverCompensationType: 'NONE',
    driverCompensationAmount: 0,
    driverPenaltyAmount: null,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    ...overrides,
  };
}

describe('CancellationPolicyService pure math & precedence (unit)', () => {
  it('derives scenarios accurately from ride state and reason code', () => {
    assert.equal(deriveCancellationScenario({ rideStatus: null }), 'BEFORE_ASSIGNMENT');
    assert.equal(
      deriveCancellationScenario({ rideStatus: 'ACCEPTED', arrivedAt: null }),
      'AFTER_ASSIGNMENT',
    );
    assert.equal(
      deriveCancellationScenario({ rideStatus: 'DRIVER_ARRIVING', arrivedAt: null }),
      'AFTER_ASSIGNMENT',
    );
    assert.equal(
      deriveCancellationScenario({ rideStatus: 'DRIVER_ARRIVED', arrivedAt: new Date() }),
      'AFTER_ARRIVAL',
    );
    assert.equal(
      deriveCancellationScenario({
        rideStatus: 'DRIVER_ARRIVED',
        arrivedAt: new Date(),
        reasonCode: 'CUSTOMER_NO_SHOW',
      }),
      'NO_SHOW',
    );
  });

  it('resolves 4-level scope cascade: CITY+VEHICLE > CITY > GLOBAL+VEHICLE > GLOBAL', () => {
    const global = makePolicy({ id: '00000000-0000-7000-8000-000000000001', feeAmount: 10 });
    const globalVeh = makePolicy({
      id: '00000000-0000-7000-8000-000000000002',
      vehicleTypeId: 'veh-1',
      feeAmount: 20,
    });
    const city = makePolicy({
      id: '00000000-0000-7000-8000-000000000003',
      cityCode: 'SGR',
      feeAmount: 30,
    });
    const cityVeh = makePolicy({
      id: '00000000-0000-7000-8000-000000000004',
      cityCode: 'SGR',
      vehicleTypeId: 'veh-1',
      feeAmount: 40,
    });

    assert.equal(
      pickWinningCancellationPolicy([global, globalVeh, city, cityVeh])?.policy.id,
      cityVeh.id,
    );
    assert.equal(pickWinningCancellationPolicy([global, globalVeh, city])?.policy.id, city.id);
    assert.equal(pickWinningCancellationPolicy([global, globalVeh])?.policy.id, globalVeh.id);
    assert.equal(pickWinningCancellationPolicy([global])?.policy.id, global.id);
  });

  it('waives fee inside grace window and assesses at exact boundary', () => {
    const policy = makePolicy({ freeCancelWindowSec: 120, feeType: 'FLAT', feeAmount: 35 });

    const inside = computeCancellationAssessment(policy, 1, {
      actor: 'CUSTOMER',
      scenario: 'AFTER_ARRIVAL',
      elapsedSec: 119,
      quotedFare: 200,
    });
    assert.equal(inside.withinGraceWindow, true);
    assert.equal(inside.freeWindowRemainingSec, 1);
    assert.equal(inside.cancellationFee, 0);
    assert.equal(inside.feeStatus, 'WAIVED');
    assert.equal(inside.reason, 'WITHIN_FREE_WINDOW');

    const atBoundary = computeCancellationAssessment(policy, 1, {
      actor: 'CUSTOMER',
      scenario: 'AFTER_ARRIVAL',
      elapsedSec: 120,
      quotedFare: 200,
    });
    assert.equal(atBoundary.withinGraceWindow, false);
    assert.equal(atBoundary.freeWindowRemainingSec, 0);
    assert.equal(atBoundary.cancellationFee, 35);
    assert.equal(atBoundary.feeStatus, 'ASSESSED');
  });

  it('applies percentage fee across fee bases, maxFee cap, and driver compensation', () => {
    const policy = makePolicy({
      freeCancelWindowSec: 60,
      feeType: 'PERCENT',
      feeAmount: 20,
      feeBase: 'QUOTED_FARE',
      maxFee: 50,
      driverCompensationType: 'PERCENT_OF_FEE',
      driverCompensationAmount: 80,
    });

    const capped = computeCancellationAssessment(policy, 4, {
      actor: 'CUSTOMER',
      scenario: 'AFTER_ARRIVAL',
      elapsedSec: 180,
      quotedFare: 400, // 20% = 80 -> capped to 50
    });
    assert.equal(capped.rawFee, 80);
    assert.equal(capped.cancellationFee, 50);
    assert.equal(capped.driverCompensation, 40); // 80% of 50
    assert.equal(capped.feeStatus, 'ASSESSED');

    const baseFarePolicy = makePolicy({
      freeCancelWindowSec: 0,
      feeType: 'PERCENT',
      feeAmount: 50,
      feeBase: 'BASE_FARE',
      driverCompensationType: 'FLAT',
      driverCompensationAmount: 15,
    });
    const baseResult = computeCancellationAssessment(baseFarePolicy, 1, {
      actor: 'CUSTOMER',
      scenario: 'AFTER_ASSIGNMENT',
      elapsedSec: 10,
      quotedFare: 300,
      baseFare: 60,
    });
    assert.equal(baseResult.baseAmountUsed, 60);
    assert.equal(baseResult.cancellationFee, 30);
    assert.equal(baseResult.driverCompensation, 15);
  });

  it('always waives SYSTEM cancellations and handles missing policy cleanly', () => {
    const sys = computeCancellationAssessment(makePolicy(), 1, {
      actor: 'SYSTEM',
      scenario: 'AFTER_ARRIVAL',
      elapsedSec: 500,
      quotedFare: 300,
    });
    assert.equal(sys.cancellationFee, 0);
    assert.equal(sys.feeStatus, 'WAIVED');
    assert.equal(sys.reason, 'SYSTEM_CANCELLATION');

    const none = computeCancellationAssessment(null, 0, {
      actor: 'CUSTOMER',
      scenario: 'BEFORE_ASSIGNMENT',
      elapsedSec: 300,
      quotedFare: 300,
    });
    assert.equal(none.cancellationFee, 0);
    assert.equal(none.feeStatus, 'WAIVED');
    assert.equal(none.reason, 'NO_ACTIVE_POLICY');
  });
});
