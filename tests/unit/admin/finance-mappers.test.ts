import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  actorLabel,
  appendTimeline,
  asTimeline,
  displayName,
  expiryStatus,
  mapDocType,
  mapGateway,
  mapPaymentMethod,
  mapSettlementDriverStatus,
  mapTxnStatus,
  mapTxnType,
  mapVerificationStatus,
  mapWalletTxnType,
  pageMeta,
} from '../../../src/modules/admin/payment-management/finance.mappers.js';

describe('finance.mappers (unit)', () => {
  describe('pageMeta', () => {
    it('computes total pages from count and limit', () => {
      assert.deepEqual(pageMeta(2, 10, 25), {
        currentPage: 2,
        totalPages: 3,
        pageSize: 10,
        totalCount: 25,
      });
    });

    it('never returns fewer than one page', () => {
      assert.equal(pageMeta(1, 20, 0).totalPages, 1);
    });
  });

  describe('mapTxnStatus', () => {
    it('maps gateway success statuses to captured', () => {
      assert.equal(mapTxnStatus('SUCCEEDED', 0, 100), 'captured');
      assert.equal(mapTxnStatus('CAPTURED', 0, 100), 'captured');
      assert.equal(mapTxnStatus('SUCCESS', 0, 100), 'captured');
    });

    it('maps failures and pending states', () => {
      assert.equal(mapTxnStatus('FAILED', 0, 100), 'failed');
      assert.equal(mapTxnStatus('PENDING', 0, 100), 'processing');
      assert.equal(mapTxnStatus('CREATED', 0, 100), 'processing');
    });

    it('derives partial and full refund states from refunded amount', () => {
      assert.equal(mapTxnStatus('SUCCEEDED', 40, 100), 'partially_refunded');
      assert.equal(mapTxnStatus('SUCCEEDED', 100, 100), 'fully_refunded');
    });
  });

  describe('mapTxnType', () => {
    it('classifies charge, refund, settlement, and adjustment types', () => {
      assert.equal(mapTxnType('CHARGE').type, 'ride_payment');
      assert.equal(mapTxnType('REFUND').type, 'refund');
      assert.equal(mapTxnType('PAYOUT').type, 'settlement');
      assert.equal(mapTxnType('ADJUSTMENT').type, 'adjustment');
      assert.equal(mapTxnType('BONUS').direction, 'credit');
      assert.equal(mapTxnType('PENALTY').direction, 'debit');
    });
  });

  describe('mapPaymentMethod / mapGateway', () => {
    it('normalizes payment methods', () => {
      assert.equal(mapPaymentMethod('UPI'), 'upi');
      assert.equal(mapPaymentMethod('CARD'), 'card');
      assert.equal(mapPaymentMethod('WALLET'), 'wallet');
      assert.equal(mapPaymentMethod('CASH'), 'cash');
    });

    it('normalizes gateway names', () => {
      assert.equal(mapGateway('razorpay_live'), 'razorpay');
      assert.equal(mapGateway('PhonePe'), 'phonepe');
      assert.equal(mapGateway('cashfree-v2'), 'cashfree');
      assert.equal(mapGateway(null), undefined);
    });
  });

  describe('document helpers', () => {
    it('maps document types and verification statuses', () => {
      assert.equal(mapDocType('DRIVING_LICENSE'), 'licence');
      assert.equal(mapDocType('RC'), 'rc');
      assert.equal(mapDocType('AADHAAR'), 'id_proof');
      assert.equal(mapDocType('POLICE_VERIFICATION'), 'police_verification');
      assert.equal(mapVerificationStatus('VERIFIED'), 'verified');
      assert.equal(mapVerificationStatus('REJECTED'), 'rejected');
      assert.equal(mapVerificationStatus('PENDING'), 'pending');
    });

    it('computes expiry status relative to threshold', () => {
      const now = new Date('2026-09-04T00:00:00.000Z');
      assert.equal(expiryStatus(null, 30, now), 'valid');
      assert.equal(expiryStatus(new Date('2026-08-01T00:00:00.000Z'), 30, now), 'expired');
      assert.equal(expiryStatus(new Date('2026-09-20T00:00:00.000Z'), 30, now), 'expiring_soon');
      assert.equal(expiryStatus(new Date('2027-01-01T00:00:00.000Z'), 30, now), 'valid');
    });
  });

  describe('timeline / labels', () => {
    it('filters invalid timeline entries and appends events', () => {
      assert.deepEqual(asTimeline(null), []);
      assert.deepEqual(asTimeline([{ action: 'x' }]), []);
      const event = {
        action: 'Refund Approved',
        actor: 'Finance',
        timestamp: '2026-09-04T10:00:00.000Z',
      };
      const next = appendTimeline([{ ...event, action: 'Refund Requested' }], event);
      assert.equal(Array.isArray(next), true);
      assert.equal((next as unknown[]).length, 2);
    });

    it('builds display names and actor labels', () => {
      assert.equal(displayName({ firstName: 'Ada', lastName: 'Lovelace' }), 'Ada Lovelace');
      assert.equal(displayName(null, 'Rider'), 'Rider');
      assert.equal(actorLabel('  Ops  '), 'Ops');
      assert.equal(actorLabel(undefined), 'Admin Operator');
    });

    it('maps wallet and settlement statuses', () => {
      assert.equal(mapWalletTxnType('WITHDRAWAL'), 'SETTLEMENT_PAYOUT');
      assert.equal(mapWalletTxnType('REFUND'), 'REFUND_DEDUCTION');
      assert.equal(mapSettlementDriverStatus('PAID'), 'paid');
      assert.equal(mapSettlementDriverStatus('PENDING'), 'pending');
    });
  });
});
