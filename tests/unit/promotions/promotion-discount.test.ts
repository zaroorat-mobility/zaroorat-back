import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PromotionService } from '../../../src/modules/promotions/promotion.service.js';

describe('PromotionService.computeDiscount', () => {
  const service = new PromotionService({} as never);

  it('computes percent discount with max cap', () => {
    assert.equal(service.computeDiscount('PERCENT', 20, 50, 400), 50);
    assert.equal(service.computeDiscount('PERCENT', 20, 50, 200), 40);
  });

  it('computes fixed discount capped by subtotal', () => {
    assert.equal(service.computeDiscount('FIXED', 30, null, 100), 30);
    assert.equal(service.computeDiscount('FIXED', 30, null, 20), 20);
  });
});
