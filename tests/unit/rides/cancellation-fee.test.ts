// Must be the first import: it sets RIDE_DEFAULT_CANCELLATION_FEE before
// `@config` freezes `rideConfig`. See the file for why it cannot just be an
// assignment at the top of this one.
import './../helpers/cancellation-fee-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CancellationService } from '../../../src/modules/rides/services/cancellation/cancellation.service.js';

type CreatedRow = {
  rideId: string;
  cancelledBy: string;
  cancelledAtStatus: string;
  cancellationFee: { toString(): string };
  feeCharged: boolean;
};

async function cancel(input: {
  cancelledBy: 'CUSTOMER' | 'DRIVER' | 'SYSTEM';
  status: string;
  arrivedAt?: Date | null;
}): Promise<CreatedRow> {
  let created: CreatedRow | undefined;
  const repo = {
    async create(row: CreatedRow) {
      created = row;
      return row;
    },
  };
  const service = new CancellationService(repo as never);
  await service.processCancellation({
    ride: {
      id: 'ride_1',
      status: input.status,
      arrivedAt: input.arrivedAt ?? null,
    } as never,
    cancelledBy: input.cancelledBy,
    reasonCode: 'CHANGED_MIND',
  });
  assert.ok(created, 'a cancellation row must always be written');
  return created;
}

describe('cancellation fees are assessed, not collected (H-2)', () => {
  it('never records a fee as charged, because nothing charges it', async () => {
    const row = await cancel({ cancelledBy: 'CUSTOMER', status: 'DRIVER_ARRIVED' });
    // The fee is real and owed; `feeCharged` claimed the money had been taken.
    // Collecting cancellation fees is out of scope for the payment feature by
    // decision (spec.md non-goals, decisions.md "never a cancelled ride"), so
    // until something actually charges one this must stay false.
    assert.equal(row.cancellationFee.toString(), '73');
    assert.equal(row.feeCharged, false);
  });

  it('takes the amount from RIDE_DEFAULT_CANCELLATION_FEE, not a literal', async () => {
    const row = await cancel({ cancelledBy: 'CUSTOMER', status: 'DRIVER_ARRIVED' });
    assert.notEqual(row.cancellationFee.toString(), '50', 'the hardcoded 50 is back');
  });

  it('charges a customer who cancels once the driver has arrived', async () => {
    const arrived = await cancel({ cancelledBy: 'CUSTOMER', status: 'DRIVER_ARRIVED' });
    assert.equal(arrived.cancellationFee.toString(), '73');
    // `arrivedAt` counts even from an earlier status: the driver made the trip
    // to the pickup point either way.
    const afterArrival = await cancel({
      cancelledBy: 'CUSTOMER',
      status: 'ACCEPTED',
      arrivedAt: new Date(),
    });
    assert.equal(afterArrival.cancellationFee.toString(), '73');
  });

  it('charges nobody who cancels before the driver arrives', async () => {
    const row = await cancel({ cancelledBy: 'CUSTOMER', status: 'ACCEPTED' });
    assert.equal(row.cancellationFee.toString(), '0');
    assert.equal(row.feeCharged, false);
  });

  it('never charges the customer for a driver or system cancellation', async () => {
    for (const cancelledBy of ['DRIVER', 'SYSTEM'] as const) {
      const row = await cancel({ cancelledBy, status: 'DRIVER_ARRIVED', arrivedAt: new Date() });
      assert.equal(row.cancellationFee.toString(), '0', `${cancelledBy} cancellation`);
      assert.equal(row.feeCharged, false);
    }
  });
});
