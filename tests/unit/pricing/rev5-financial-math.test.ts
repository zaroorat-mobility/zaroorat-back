import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateCommission,
  type ResolvedCommissionConfig,
} from '../../../src/modules/pricing/services/commission.service.js';
import {
  calculatePassengerGst,
  type ResolvedTaxConfig,
  type ResolvedTaxJurisdiction,
} from '../../../src/modules/pricing/services/tax.service.js';
import {
  calculateGstRecovery,
  type ResolvedGstRecoveryConfig,
} from '../../../src/modules/pricing/services/gst-recovery.service.js';
import {
  normalizeScopeTuple,
  pickWinningScope,
} from '../../../src/modules/pricing/utils/scope-precedence.js';
import { SCOPE_GLOBAL_CITY, SCOPE_NIL_UUID } from '../../../src/modules/pricing/constants.js';

const BASE_COMM_CONFIG: ResolvedCommissionConfig = {
  configId: '00000000-0000-7000-8000-000000000001',
  familyId: '00000000-0000-7000-8000-000000000011',
  version: 1,
  scopeId: '00000000-0000-7000-8000-000000000021',
  scopeLevel: 'GLOBAL',
  cityCode: SCOPE_GLOBAL_CITY,
  serviceZoneId: SCOPE_NIL_UUID,
  vehicleTypeId: SCOPE_NIL_UUID,
  commissionRatePct: 7,
  isEnabled: true,
  baseRule: 'RIDE_SUBTOTAL_BEFORE_DISCOUNT',
  includeSurge: true,
  includeWaiting: false,
  includeBookingFee: false,
  applyMinimumFloor: true,
  roundOffRupee: false,
};

const INTRA_JURISDICTION: ResolvedTaxJurisdiction = {
  legalEntityId: '00000000-0000-7000-8000-000000000031',
  legalEntityName: 'Zaroorat Mobility Private Limited',
  pan: 'AAACZ1234A',
  gstRegistrationId: '00000000-0000-7000-8000-000000000041',
  supplierGstin: '01AAACZ1234A1Z5',
  supplierStateCode: '01',
  supplierStateName: 'Jammu and Kashmir',
  placeOfSupplyCityCode: 'SGR',
  placeOfSupplyStateCode: '01',
  placeOfSupplyStateName: 'Jammu and Kashmir',
  supplyType: 'INTRA_STATE',
};

const INTER_JURISDICTION: ResolvedTaxJurisdiction = {
  ...INTRA_JURISDICTION,
  placeOfSupplyCityCode: 'DEL',
  placeOfSupplyStateCode: '07',
  placeOfSupplyStateName: 'Delhi',
  supplyType: 'INTER_STATE',
};

const BASE_TAX_CONFIG: ResolvedTaxConfig = {
  configId: '00000000-0000-7000-8000-000000000002',
  familyId: '00000000-0000-7000-8000-000000000012',
  version: 1,
  kind: 'PASSENGER_RIDE_GST',
  scopeId: '00000000-0000-7000-8000-000000000022',
  scopeLevel: 'GLOBAL',
  ratePct: 5,
  isEnabled: true,
  inclusive: false,
  waitingTaxable: true,
  sacCode: '996412',
  legalReference: 'CA-OPINION-2026-01',
};

const BASE_RECOVERY_CONFIG: ResolvedGstRecoveryConfig = {
  configId: '00000000-0000-7000-8000-000000000003',
  familyId: '00000000-0000-7000-8000-000000000013',
  version: 1,
  scopeId: '00000000-0000-7000-8000-000000000023',
  scopeLevel: 'GLOBAL',
  recoveryRatePct: 5,
  isEnabled: true,
  baseRule: 'PASSENGER_GST_AMOUNT',
  roundOffRupee: false,
  legalReference: 'CA-RECOVERY-2026-01',
};

describe('Phase 4 — Rev 5 Worked Financial Examples & 6-Tier Scope Precedence (unit)', () => {
  it('reproduces Rev 5 §4.2 worked commission and ALL 4 GST variants to the exact paisa', () => {
    // Worked trip: Base ₹30, Dist ₹80, Time ₹20 -> ₹130 + 1.2x surge (+₹26) = ₹156 ride subtotal, Waiting ₹2, Booking ₹0
    const comm = calculateCommission(BASE_COMM_CONFIG, {
      baseFare: 30,
      distanceFare: 80,
      timeFare: 20,
      surgeAmount: 26,
      waitingCharge: 2,
      bookingFee: 0,
      minimumFare: 60,
      discountAmount: 0,
    });
    assert.equal(comm.calculationBaseAmount, 156);
    assert.equal(comm.commissionAmount, 10.92);

    // Variant 1A: waiting_taxable=true, Exclusive
    const v1a = calculatePassengerGst(
      { ...BASE_TAX_CONFIG, waitingTaxable: true, inclusive: false },
      INTRA_JURISDICTION,
      { rideSubtotal: 156, waitingCharge: 2, bookingFee: 0 },
    );
    assert.equal(v1a.nonTaxableWaitingAmount, 0);
    assert.equal(v1a.taxableValue, 158);
    assert.equal(v1a.totalTaxAmount, 7.9);
    assert.equal(v1a.cgstAmount, 3.95);
    assert.equal(v1a.sgstAmount, 3.95);
    assert.equal(v1a.igstAmount, 0);
    assert.equal(v1a.grossCustomerFare, 165.9);

    // Variant 1B: waiting_taxable=true, Inclusive
    const v1b = calculatePassengerGst(
      { ...BASE_TAX_CONFIG, waitingTaxable: true, inclusive: true },
      INTRA_JURISDICTION,
      { rideSubtotal: 156, waitingCharge: 2, bookingFee: 0 },
    );
    assert.equal(v1b.taxableValue, 150.48);
    assert.equal(v1b.totalTaxAmount, 7.52);
    assert.equal(v1b.cgstAmount, 3.76);
    assert.equal(v1b.sgstAmount, 3.76);
    assert.equal(v1b.grossCustomerFare, 158);

    // Variant 2A: waiting_taxable=false, Exclusive
    const v2a = calculatePassengerGst(
      { ...BASE_TAX_CONFIG, waitingTaxable: false, inclusive: false },
      INTRA_JURISDICTION,
      { rideSubtotal: 156, waitingCharge: 2, bookingFee: 0 },
    );
    assert.equal(v2a.nonTaxableWaitingAmount, 2);
    assert.equal(v2a.taxableValue, 156);
    assert.equal(v2a.totalTaxAmount, 7.8);
    assert.equal(v2a.cgstAmount, 3.9);
    assert.equal(v2a.sgstAmount, 3.9);
    assert.equal(v2a.grossCustomerFare, 165.8);

    // Variant 2B: waiting_taxable=false, Inclusive (odd-paise split: 3.72 + 3.71 = 7.43)
    const v2b = calculatePassengerGst(
      { ...BASE_TAX_CONFIG, waitingTaxable: false, inclusive: true },
      INTRA_JURISDICTION,
      { rideSubtotal: 156, waitingCharge: 2, bookingFee: 0 },
    );
    assert.equal(v2b.nonTaxableWaitingAmount, 2);
    assert.equal(v2b.taxableValue, 148.57);
    assert.equal(v2b.totalTaxAmount, 7.43);
    assert.equal(v2b.cgstAmount, 3.72);
    assert.equal(v2b.sgstAmount, 3.71);
    assert.equal(v2b.grossCustomerFare, 158);

    // Inter-state supply splits 100% into IGST
    const inter = calculatePassengerGst(
      { ...BASE_TAX_CONFIG, waitingTaxable: false, inclusive: false },
      INTER_JURISDICTION,
      { rideSubtotal: 156, waitingCharge: 2, bookingFee: 0 },
    );
    assert.equal(inter.cgstAmount, 0);
    assert.equal(inter.sgstAmount, 0);
    assert.equal(inter.igstAmount, 7.8);

    // Mode A reservation totals: C + R_gst
    const rec1a = calculateGstRecovery(BASE_RECOVERY_CONFIG, {
      passengerGstAmount: v1a.totalTaxAmount,
      taxableValue: v1a.taxableValue,
      rideSubtotalBeforeDiscount: 156,
    });
    assert.equal(Math.round((comm.commissionAmount + rec1a.recoveryAmount) * 100) / 100, 18.82);
  });

  it('enforces 6-tier scope normalization and deterministic precedence', () => {
    const g = normalizeScopeTuple({});
    assert.equal(g.scopeLevel, 'GLOBAL');
    assert.equal(g.cityCode, SCOPE_GLOBAL_CITY);
    assert.equal(g.serviceZoneId, SCOPE_NIL_UUID);

    const zv = normalizeScopeTuple({
      cityCode: 'SGR',
      serviceZoneId: '00000000-0000-7000-8000-000000000100',
      vehicleTypeId: '00000000-0000-7000-8000-000000000200',
    });
    assert.equal(zv.scopeLevel, 'ZONE_VEHICLE');

    assert.throws(
      () => normalizeScopeTuple({ serviceZoneId: '00000000-0000-7000-8000-000000000100' }),
      /requires a non-global cityCode/i,
    );

    const t = new Date('2026-11-18T00:00:00Z');
    const winner = pickWinningScope([
      { id: '1', scopeLevel: 'GLOBAL', effectiveFrom: t },
      { id: '2', scopeLevel: 'CITY', effectiveFrom: t },
      { id: '3', scopeLevel: 'CITY_VEHICLE', effectiveFrom: t },
      { id: '4', scopeLevel: 'ZONE_VEHICLE', effectiveFrom: t },
      { id: '5', scopeLevel: 'ZONE', effectiveFrom: t },
    ]);
    assert.equal(winner?.id, '4');
  });
});
