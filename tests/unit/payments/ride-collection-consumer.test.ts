import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RideCollectionConsumer } from '../../../src/modules/payments/consumers/ride-collection.consumer.js';

interface Handler {
  (envelope: unknown): Promise<void> | void;
}

function makeConsumer(collect: (rideId: string) => Promise<string>) {
  const handlers = new Map<string, Handler>();
  const bus = {
    on: (type: string, handler: Handler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  };
  const receipts: string[] = [];
  const consumer = new RideCollectionConsumer(
    bus as never,
    { collect } as never,
    {
      generateReceipt: async (rideId: string) => receipts.push(rideId),
    } as never,
  );
  const unsubscribe = consumer.register();
  return { handlers, unsubscribe, receipts };
}

describe('ride collection consumer', () => {
  it('subscribes to ride.completed and nothing else', () => {
    const { handlers } = makeConsumer(async () => 'COLLECTED');
    assert.deepEqual([...handlers.keys()], ['ride.completed']);
  });

  it('reads the ride id from envelope.data, not from the aggregate id', async () => {
    const seen: string[] = [];
    const { handlers } = makeConsumer(async (rideId) => {
      seen.push(rideId);
      return 'COLLECTED';
    });

    // The shape `buildEnvelope` actually produces: no aggregateId survives it,
    // and a ride event carries no subject user. Reading either would have
    // handed `collect` an undefined and silently collected nothing.
    await handlers.get('ride.completed')!({
      eventId: 'e-1',
      type: 'ride.completed',
      subject: { userId: null },
      data: { rideId: 'ride-1', driverId: 'drv-1', totalFare: 240 },
    });

    assert.deepEqual(seen, ['ride-1']);
  });

  it('ignores an envelope with no ride id rather than collecting nothing', async () => {
    let called = 0;
    const { handlers } = makeConsumer(async () => {
      called++;
      return 'COLLECTED';
    });

    await handlers.get('ride.completed')!({ data: {} });
    await handlers.get('ride.completed')!({ data: { rideId: null } });

    assert.equal(called, 0);
  });

  it('swallows a collection failure so one ride cannot stall the outbox', async () => {
    const { handlers } = makeConsumer(async () => {
      throw new Error('gateway on fire');
    });

    await assert.doesNotReject(() =>
      Promise.resolve(handlers.get('ride.completed')!({ data: { rideId: 'ride-1' } })),
    );
  });

  it('unsubscribes cleanly', () => {
    const { handlers, unsubscribe } = makeConsumer(async () => 'COLLECTED');
    unsubscribe();
    assert.equal(handlers.size, 0);
  });

  it('issues a receipt for a ride collection had nothing to do for', async () => {
    // A cash ride with the BD-5 flag off: already PAID at completion, so
    // nothing collects it and nothing else would ever give it a receipt.
    const { handlers, receipts } = makeConsumer(async () => 'NOT_COLLECTABLE');

    await handlers.get('ride.completed')!({ data: { rideId: 'ride-1' } });

    assert.deepEqual(receipts, ['ride-1']);
  });

  it('leaves the receipt to the collection transaction when it does collect', async () => {
    const { handlers, receipts } = makeConsumer(async () => 'COLLECTED');

    await handlers.get('ride.completed')!({ data: { rideId: 'ride-1' } });

    assert.deepEqual(receipts, [], 'issued inside the transaction, not here');
  });
});
