import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal } from '../../../src/modules/payments/types/index.js';
import { LedgerService } from '../../../src/modules/payments/services/ledger/ledger.service.js';
import type { LedgerRepository } from '../../../src/modules/payments/repositories/ledger.repository.js';
import type { LedgerItemInput } from '../../../src/modules/payments/repositories/ledger.repository.js';

/// FR-006. Where a completed ride's money goes, proved rather than asserted.
///
/// Phase 2 changed the split: the driver is paid out of ride revenue alone, so
/// tax and the platform fee became destinations of their own instead of being
/// swallowed by the commission line. `postGroup` refuses an unbalanced group, so
/// getting this wrong does not produce bad books — it produces no books at all,
/// and every ride completion throws.
///
/// These run against the real `LedgerService` with only the repository stubbed,
/// so the legs under test are the legs that would be written.

interface Captured {
  items: LedgerItemInput[];
}

function serviceCapturing(into: Captured): LedgerService {
  const repo = {
    postGroup: async (items: LedgerItemInput[]) => {
      // The real repository's balance rule, applied here so a group that would
      // be rejected in production is rejected in this test too.
      let debit = new Decimal(0);
      let credit = new Decimal(0);
      for (const item of items) {
        if (item.amount.lte(0)) {
          throw new Error(`Ledger entry amount must be strictly positive: ${item.amount}`);
        }
        if (item.direction === 'DEBIT') debit = debit.add(item.amount);
        else credit = credit.add(item.amount);
      }
      if (!debit.equals(credit)) {
        throw new Error(`Ledger imbalance: debits ${debit} vs credits ${credit}`);
      }
      into.items = items;
      return items as never;
    },
  } as unknown as LedgerRepository;
  return new LedgerService(repo);
}

interface Split {
  totalFare: number;
  driverEarning: number;
  platformCommission: number;
  taxAmount: number;
  platformFee: number;
}

async function post(split: Split, paymentMethod: string): Promise<LedgerItemInput[]> {
  const captured: Captured = { items: [] };
  await serviceCapturing(captured).recordTripPayment(
    {
      totalFare: new Decimal(split.totalFare),
      driverEarning: new Decimal(split.driverEarning),
      driverPayable: new Decimal(split.driverEarning),
      platformCommission: new Decimal(split.platformCommission),
      taxAmount: new Decimal(split.taxAmount),
      platformFee: new Decimal(split.platformFee),
      customerUserId: 'customer-1',
      driverId: 'driver-1',
      rideId: 'ride-1',
      paymentMethod,
    },
    {} as never,
  );
  return captured.items;
}

/// The signed total for an account: credits positive, debits negative.
function net(items: LedgerItemInput[], account: string): Decimal {
  return items
    .filter((i) => i.account === account)
    .reduce(
      (sum, i) => (i.direction === 'CREDIT' ? sum.add(i.amount) : sum.sub(i.amount)),
      new Decimal(0),
    );
}

/// The default card from the spec on a 300 ride: 5% tax, 20% commission,
/// 15 flat platform fee. 240 + 60 + 15 + 15 = 330.
const ORDINARY: Split = {
  totalFare: 330,
  driverEarning: 240,
  platformCommission: 60,
  taxAmount: 15,
  platformFee: 15,
};

/// A promotion larger than the platform's margin. The driver is still paid on
/// the pre-discount base (BD-2 A), so the platform's residual is negative — it
/// genuinely paid out more than it collected on this ride.
const HEAVILY_DISCOUNTED: Split = {
  totalFare: 130,
  driverEarning: 240,
  platformCommission: -140,
  taxAmount: 15,
  platformFee: 15,
};

/// A promotion covering the whole fare, on a rule with no platform fee and no
/// tax. The customer pays nothing; the platform funds the driver outright.
const FULLY_DISCOUNTED: Split = {
  totalFare: 0,
  driverEarning: 80,
  platformCommission: -80,
  taxAmount: 0,
  platformFee: 0,
};

describe('ride fare reaches the ledger intact (FR-006)', () => {
  for (const method of ['WALLET', 'CARD', 'UPI', 'CASH']) {
    describe(`paid by ${method}`, () => {
      for (const [label, split] of [
        ['an ordinary ride', ORDINARY],
        ['a heavily discounted ride', HEAVILY_DISCOUNTED],
        ['a fully discounted ride', FULLY_DISCOUNTED],
      ] as const) {
        it(`balances, and creates no money, for ${label}`, async () => {
          // The stub throws on imbalance and on a non-positive amount, so
          // reaching this line at all is the balance assertion.
          const items = await post(split, method);

          // No money created or lost: the driver, the state, the platform fee
          // and the platform's residual account for the whole fare.
          const accountedFor = new Decimal(split.driverEarning)
            .add(split.platformCommission)
            .add(split.taxAmount)
            .add(split.platformFee);
          assert.equal(
            accountedFor.toFixed(2),
            new Decimal(split.totalFare).toFixed(2),
            'the four destinations must sum to what the customer was charged',
          );

          // Each destination carries its own amount, not a share of another's.
          assert.equal(
            net(items, 'TAX_PAYABLE').toFixed(2),
            new Decimal(split.taxAmount).toFixed(2),
          );
          assert.equal(
            net(items, 'PLATFORM_FEE').toFixed(2),
            new Decimal(split.platformFee).toFixed(2),
          );
          assert.equal(
            net(items, 'PLATFORM_COMMISSION').toFixed(2),
            new Decimal(split.platformCommission).toFixed(2),
            'a negative residual is posted as a debit, not dropped',
          );
        });
      }
    });
  }

  it('credits the driver their earning when the platform collected the fare', async () => {
    for (const method of ['WALLET', 'CARD', 'UPI']) {
      const items = await post(ORDINARY, method);
      assert.equal(
        net(items, 'DRIVER_PAYABLE').toFixed(2),
        new Decimal(ORDINARY.driverEarning).toFixed(2),
        `${method}: the platform owes the driver exactly their earning`,
      );
    }
  });

  it('debits the driver the whole platform share when they took the cash', async () => {
    const items = await post(ORDINARY, 'CASH');
    // They collected 330 and are entitled to 240, so they owe 90 — the
    // commission plus the tax and the fee they are also holding. Charging only
    // the commission left 30 in the driver's pocket with nothing recording it.
    assert.equal(net(items, 'DRIVER_PAYABLE').toFixed(2), '-90.00');
    assert.ok(
      new Decimal(90).gt(new Decimal(ORDINARY.platformCommission)),
      'the debt exceeds the commission alone whenever tax or a fee applies',
    );
  });

  it('never writes a zero-amount leg', async () => {
    // `postTransactionGroup` rejects one outright, so a zero fare, a zero tax or
    // a zero platform fee must produce no leg rather than an empty one. This is
    // what a fully discounted ride hits: it used to throw
    // `Ledger entry amount must be strictly positive: 0` and fail to settle.
    for (const method of ['WALLET', 'CARD', 'CASH']) {
      const items = await post(FULLY_DISCOUNTED, method);
      for (const item of items) {
        assert.ok(item.amount.gt(0), `${method}: ${item.account} leg has a non-positive amount`);
      }
    }
  });

  it('funds the driver from the platform when the customer pays nothing', async () => {
    const items = await post(FULLY_DISCOUNTED, 'WALLET');
    // No customer leg at all — they were charged nothing, so there is nothing
    // to debit them for.
    assert.equal(net(items, 'CUSTOMER_WALLET').toFixed(2), '0.00');
    assert.equal(net(items, 'DRIVER_PAYABLE').toFixed(2), '80.00');
    assert.equal(net(items, 'PLATFORM_COMMISSION').toFixed(2), '-80.00');
  });
});
