import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmergencyContactService } from '../../../src/modules/users/services/emergency-contact/emergency-contact.service.js';
import { SavedPlaceService } from '../../../src/modules/users/services/saved-place/saved-place.service.js';
import {
  LabelConflictError,
  LimitExceededError,
  UserNotFoundError,
} from '../../../src/modules/users/errors/user.errors.js';
import { UniqueConstraintError } from '../../../src/core/database/errors/DatabaseError.js';
import { userConfig } from '../../../src/config/user/index.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

const USER_ID = '00000000-0000-7000-8000-000000000001';
const ITEM_ID = '00000000-0000-7000-8000-0000000000e1';

interface Options {
  count?: number;
  conflicts?: boolean;
  missing?: boolean;
}

function harness(opts: Options) {
  const seen = {
    order: [] as string[],
    txSeen: {} as Record<string, unknown>,
    published: [] as { input: PublishInput; tx: unknown }[],
    written: undefined as unknown,
  };

  const record = (step: string, tx?: unknown) => {
    seen.order.push(step);
    if (tx !== undefined) seen.txSeen[step] = tx;
  };

  const userRepository = {
    lockForUpdate: async (_id: string, tx: TransactionClient) => record('lock', tx),
  };
  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
      record('tx:begin');
      const out = await cb(TX);
      record('tx:commit');
      return out;
    },
  };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.published.push({ input, tx });
      record(`publish:${input.type}`, tx);
    },
  };

  const repository = (row: Record<string, unknown>) => ({
    findAllByUser: async () => [row],
    findOwned: async () => (opts.missing ? null : row),
    countByUser: async (_userId: string, tx: TransactionClient) => {
      record('count', tx);
      return opts.count ?? 0;
    },
    create: async (input: unknown, tx: TransactionClient) => {
      record('create', tx);
      seen.written = input;
      if (opts.conflicts) throw new UniqueConstraintError('user_id, lower(label)');
      return row;
    },
    updateOwned: async (_userId: string, _id: string, input: unknown, tx: TransactionClient) => {
      record('update', tx);
      seen.written = input;
      if (opts.conflicts) throw new UniqueConstraintError('user_id, lower(label)');
      return opts.missing ? null : row;
    },
    deleteOwned: async (_userId: string, _id: string, tx: TransactionClient) => {
      record('delete', tx);
      return !opts.missing;
    },
  });

  return { seen, userRepository, transactionManager, eventPublisher, repository };
}

const CONTACT_ROW = {
  id: ITEM_ID,
  contactName: 'Priya',
  phoneNumber: '+919876500042',
  relationship: 'SPOUSE',
  priority: 2,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const PLACE_ROW = {
  id: ITEM_ID,
  label: 'Home',
  address: '12 MG Road, Bengaluru',
  buildingName: null,
  landmark: 'opposite the metro station',
  floor: null,
  instructions: 'Call on arrival',
  latitude: 12.9716,
  longitude: 77.5946,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

function makeContactService(opts: Options = {}) {
  const h = harness(opts);
  const service = new EmergencyContactService(
    h.repository(CONTACT_ROW) as never,
    h.userRepository as never,
    h.transactionManager as never,
    h.eventPublisher as never,
  );
  return { service, seen: h.seen };
}

function makePlaceService(opts: Options = {}) {
  const h = harness(opts);
  const service = new SavedPlaceService(
    h.repository(PLACE_ROW) as never,
    h.userRepository as never,
    h.transactionManager as never,
    h.eventPublisher as never,
  );
  return { service, seen: h.seen };
}

describe('emergency contacts — unit of work (unit)', () => {
  it('locks the owner before counting, and counts inside the same transaction', async () => {
    const { service, seen } = makeContactService();
    await service.add(USER_ID, { contactName: 'Priya', phoneNumber: '+919876500042' });

    assert.deepEqual(seen.order, [
      'tx:begin',
      'lock',
      'count',
      'create',
      'publish:user.emergency_contact.added',
      'tx:commit',
    ]);
    for (const step of ['lock', 'count', 'create', 'publish:user.emergency_contact.added']) {
      assert.equal(seen.txSeen[step], TX, `${step} joins the write transaction`);
    }
  });

  it('refuses at the cap, before writing anything', async () => {
    const { service, seen } = makeContactService({ count: userConfig.maxEmergencyContacts });
    await assert.rejects(
      service.add(USER_ID, { contactName: 'Priya', phoneNumber: '+919876500042' }),
      (err: unknown) =>
        err instanceof LimitExceededError &&
        err.details?.[0]?.limit === userConfig.maxEmergencyContacts &&
        err.details?.[0]?.field === 'emergencyContacts',
    );
    assert.equal(seen.order.includes('create'), false);
    assert.equal(seen.published.length, 0, 'a refusal announces nothing');
  });

  it('keeps a contact’s name and number out of every payload (doc 05 §3.4)', async () => {
    const { service, seen } = makeContactService();
    await service.add(USER_ID, { contactName: 'Priya', phoneNumber: '+919876500042' });

    const event = seen.published[0]!.input;
    assert.equal(event.producer, 'users');
    assert.equal(event.classification, 'domain');
    assert.deepEqual(event.data, { userId: USER_ID, contactId: ITEM_ID, priority: 2 });

    const payload = JSON.stringify(event);
    assert.ok(!payload.includes('Priya'));
    assert.ok(!payload.includes('+919876500042'));
  });

  it('announces an edit by field name only', async () => {
    const { service, seen } = makeContactService();
    await service.update(USER_ID, ITEM_ID, { priority: 1, relationship: null });

    const event = seen.published[0]!.input;
    assert.deepEqual(event.data, {
      userId: USER_ID,
      contactId: ITEM_ID,
      changedFields: ['priority', 'relationship'],
    });
    assert.equal(seen.published[0]!.tx, TX, 'but it is published on the write transaction');
  });

  it('treats an empty patch as a no-op, without claiming a change', async () => {
    const { service, seen } = makeContactService();
    await service.update(USER_ID, ITEM_ID, {});
    assert.deepEqual(seen.order, [], 'no transaction, no write, no event');
  });

  it('reports an unowned id as NOT_FOUND on every path', async () => {
    for (const act of [
      (s: EmergencyContactService) => s.update(USER_ID, ITEM_ID, { priority: 1 }),
      (s: EmergencyContactService) => s.update(USER_ID, ITEM_ID, {}),
      (s: EmergencyContactService) => s.remove(USER_ID, ITEM_ID),
    ]) {
      const { service, seen } = makeContactService({ missing: true });
      await assert.rejects(act(service), UserNotFoundError);
      assert.equal(seen.published.length, 0, 'nothing happened, so nothing is announced');
    }
  });

  it('announces a removal with the id and nothing else', async () => {
    const { service, seen } = makeContactService();
    await service.remove(USER_ID, ITEM_ID);
    assert.deepEqual(seen.order, [
      'tx:begin',
      'delete',
      'publish:user.emergency_contact.removed',
      'tx:commit',
    ]);
    assert.deepEqual(seen.published[0]!.input.data, { userId: USER_ID, contactId: ITEM_ID });
  });
});

describe('saved places — unit of work (unit)', () => {
  it('locks the owner before counting, and counts inside the same transaction', async () => {
    const { service, seen } = makePlaceService();
    await service.add(USER_ID, { label: 'Home' });

    assert.deepEqual(seen.order, [
      'tx:begin',
      'lock',
      'count',
      'create',
      'publish:user.saved_place.added',
      'tx:commit',
    ]);
  });

  it('refuses at the cap, before writing anything', async () => {
    const { service, seen } = makePlaceService({ count: userConfig.maxSavedPlaces });
    await assert.rejects(
      service.add(USER_ID, { label: 'Home' }),
      (err: unknown) =>
        err instanceof LimitExceededError && err.details?.[0]?.field === 'savedPlaces',
    );
    assert.equal(seen.order.includes('create'), false);
  });

  it('carries the label but never an address or a coordinate (doc 05 §3.4)', async () => {
    const { service, seen } = makePlaceService();
    await service.add(USER_ID, {
      label: 'Home',
      address: '12 MG Road, Bengaluru',
      coordinates: { latitude: 12.9716, longitude: 77.5946 },
    });

    const event = seen.published[0]!.input;
    assert.deepEqual(event.data, { userId: USER_ID, placeId: ITEM_ID, label: 'Home' });

    const payload = JSON.stringify(event);
    assert.ok(!payload.includes('MG Road'));
    assert.ok(!payload.includes('12.97'));
    assert.ok(!payload.includes('77.59'));
  });

  it('turns a label collision into CONFLICT, on create and on edit alike', async () => {
    const created = makePlaceService({ conflicts: true });
    await assert.rejects(created.service.add(USER_ID, { label: 'home' }), LabelConflictError);

    const edited = makePlaceService({ conflicts: true });
    await assert.rejects(
      edited.service.update(USER_ID, ITEM_ID, { label: 'home' }),
      LabelConflictError,
    );
  });

  it('renders the stored decimals as numbers, not as Decimal objects', async () => {
    const { service } = makePlaceService();
    const [place] = await service.list(USER_ID);
    assert.equal(place?.latitude, 12.9716);
    assert.equal(place?.longitude, 77.5946);
    assert.equal(typeof place?.latitude, 'number');
  });

  it('reports an unowned id as NOT_FOUND on every path', async () => {
    for (const act of [
      (s: SavedPlaceService) => s.update(USER_ID, ITEM_ID, { label: 'Work' }),
      (s: SavedPlaceService) => s.update(USER_ID, ITEM_ID, {}),
      (s: SavedPlaceService) => s.remove(USER_ID, ITEM_ID),
    ]) {
      const { service, seen } = makePlaceService({ missing: true });
      await assert.rejects(act(service), UserNotFoundError);
      assert.equal(seen.published.length, 0);
    }
  });
});
