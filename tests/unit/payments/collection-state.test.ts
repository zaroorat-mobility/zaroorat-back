import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import {
  projectCollectionState,
  type CollectionInput,
} from '../../../src/modules/payments/services/collection/collection-state.js';

const FARE = new Decimal(180);

function project(overrides: Partial<CollectionInput>) {
  return projectCollectionState({
    paymentStatus: 'PENDING',
    method: 'CARD',
    attempts: [],
    totalFare: FARE,
    ...overrides,
  });
}

describe('collectionState projection (data-model §2.2)', () => {
  it('maps every row of the table', () => {
    assert.equal(
      project({ method: 'CASH' }).collectionState,
      'AWAITING_CASH_CONFIRMATION',
      'cash, unconfirmed',
    );
    assert.equal(project({}).collectionState, 'AWAITING_COLLECTION', 'non-cash, no attempt yet');
    assert.equal(
      project({ attempts: [{ status: 'FAILED' }] }).collectionState,
      'RETRYING',
      'non-cash, an attempt failed',
    );
    assert.equal(
      project({ paymentStatus: 'PAID', attempts: [{ status: 'SUCCEEDED' }] }).collectionState,
      'PAID',
    );
    assert.equal(
      project({ paymentStatus: 'FAILED', attempts: [{ status: 'FAILED' }] }).collectionState,
      'UNPAID',
      'attempts exhausted, no write-off',
    );
    assert.equal(
      project({ paymentStatus: 'FAILED', attempts: [{ status: 'WRITTEN_OFF' }] }).collectionState,
      'WRITTEN_OFF',
    );
  });

  it('owes the fare only while the receivable is open', () => {
    assert.equal(project({ paymentStatus: 'FAILED' }).amountOwed.toNumber(), 180);
    // BD-1c: a written-off receivable is closed, so nothing is outstanding.
    assert.equal(
      project({
        paymentStatus: 'FAILED',
        attempts: [{ status: 'WRITTEN_OFF' }],
      }).amountOwed.toNumber(),
      0,
    );
    assert.equal(project({ paymentStatus: 'PAID' }).amountOwed.toNumber(), 0);
    assert.equal(project({}).amountOwed.toNumber(), 0);
  });

  it('never emits either internal FAILED (FR-041)', () => {
    const everyShape: Partial<CollectionInput>[] = [
      {},
      { method: 'CASH' },
      { attempts: [{ status: 'FAILED' }] },
      { paymentStatus: 'PAID', attempts: [{ status: 'SUCCEEDED' }] },
      { paymentStatus: 'FAILED', attempts: [{ status: 'FAILED' }] },
      { paymentStatus: 'FAILED', attempts: [{ status: 'WRITTEN_OFF' }] },
      { paymentStatus: 'AUTHORIZED' },
      { paymentStatus: 'REFUNDED' },
    ];
    for (const shape of everyShape) {
      assert.notEqual(project(shape).collectionState, 'FAILED');
    }
  });

  it('leaves a confirmed cash ride out of the cash-waiting state', () => {
    assert.equal(
      project({ method: 'CASH', attempts: [{ status: 'SUCCEEDED' }] }).collectionState,
      'AWAITING_COLLECTION',
    );
  });
});
