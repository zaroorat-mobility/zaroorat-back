import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserService } from '../../../src/modules/users/services/user.service.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

const USER_ID = '00000000-0000-7000-8000-000000000001';

const USER_ROW = {
  id: USER_ID,
  phoneNumber: '+919876543210',
  email: null,
  isPhoneVerified: true,
  isEmailVerified: false,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
};

function makeService(opts: { profile?: Record<string, unknown> | null; user?: unknown } = {}) {
  const seen = {
    executeCalls: 0,
    updateTx: undefined as unknown,
    publishTx: undefined as unknown,
    published: [] as PublishInput[],
    updateInput: undefined as unknown,
    order: [] as string[],
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
      seen.executeCalls += 1;
      return cb(TX);
    },
  };
  const userRepository = {
    findById: async () => (opts.user === undefined ? USER_ROW : opts.user),
  };
  const userProfileRepository = {
    findByUserId: async () => opts.profile ?? null,
    update: async (_userId: string, input: unknown, tx: TransactionClient) => {
      seen.updateTx = tx;
      seen.updateInput = input;
      seen.order.push('update');
      return { userId: USER_ID, ...(input as Record<string, unknown>) };
    },
  };
  const roleRepository = {
    findActiveRoleSlugs: async () => ['customer'],
  };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.publishTx = tx;
      seen.published.push(input);
      seen.order.push('publish');
    },
  };

  const fileService = {
    assertReferenceable: async () => {
      seen.order.push('assertReferenceable');
    },
    supersede: async () => {
      seen.order.push('supersede');
    },
  };

  const service = new UserService(
    userRepository as never,
    userProfileRepository as never,
    roleRepository as never,
    transactionManager as never,
    eventPublisher as never,
    fileService as never,
  );
  return { service, seen };
}

describe('UserService.updateProfile — unit of work (unit)', () => {
  it('writes the row and the event inside one transaction', async () => {
    const { service, seen } = makeService();
    await service.updateProfile(USER_ID, { firstName: 'Aarav' }, 'req-1');

    assert.equal(seen.executeCalls, 1, 'exactly one transaction');
    assert.equal(seen.updateTx, TX, 'the row write joins the transaction');
    assert.equal(seen.publishTx, TX, 'the outbox write joins the SAME transaction');
    assert.deepEqual(seen.order, ['update', 'publish'], 'the event follows the change it records');
  });

  it('emits user.profile.updated with field NAMES only (doc 05 §5)', async () => {
    const { service, seen } = makeService();
    await service.updateProfile(
      USER_ID,
      { firstName: 'Aarav', dateOfBirth: new Date('1994-03-11T00:00:00.000Z') },
      'req-2',
    );

    assert.equal(seen.published.length, 1);
    const event = seen.published[0]!;
    assert.equal(event.type, 'user.profile.updated');
    assert.equal(event.classification, 'domain');
    assert.equal(event.producer, 'users', 'the envelope names this module (doc 05 §2)');
    assert.equal(event.subjectUserId, USER_ID);
    assert.equal(event.requestId, 'req-2');
    assert.deepEqual(event.data, { userId: USER_ID, changedFields: ['firstName', 'dateOfBirth'] });

    const serialized = JSON.stringify(event.data);
    assert.ok(!serialized.includes('Aarav'), 'no name in the payload');
    assert.ok(!serialized.includes('1994'), 'no date of birth in the payload');
  });

  it('reports a cleared field by name, exactly like a set one', async () => {
    const { service, seen } = makeService();
    await service.updateProfile(USER_ID, { lastName: null }, null);
    assert.deepEqual(seen.published[0]!.data.changedFields, ['lastName']);
  });

  it('treats an empty patch as a no-op: no transaction, no event', async () => {
    const { service, seen } = makeService();
    const result = await service.updateProfile(USER_ID, {}, 'req-3');

    assert.equal(seen.executeCalls, 0, 'no transaction is opened');
    assert.equal(seen.published.length, 0, 'no event claims a change that did not happen');
    assert.equal(result.firstName, null, 'the current profile is still returned');
  });

  it('passes the caller-supplied keys through to the repository unchanged', async () => {
    const { service, seen } = makeService();
    await service.updateProfile(USER_ID, { firstName: 'Aarav', gender: null }, null);
    assert.deepEqual(seen.updateInput, { firstName: 'Aarav', gender: null });
  });
});

describe('UserService.getMe (unit)', () => {
  it('returns live roles and an empty profile when the account has no row yet', async () => {
    const { service } = makeService({ profile: null });
    const view = await service.getMe(USER_ID);

    assert.equal(view.id, USER_ID);
    assert.deepEqual(view.roles, ['customer'], 'roles come from user_roles, not the token claim');
    assert.notEqual(view.profile, null, 'profile is never null on the wire (doc 02 §2.1)');
    assert.equal(view.profile.firstName, null);
    assert.equal(view.profile.languageCode, 'en', 'the default language still resolves');
  });

  it('renders dateOfBirth as a calendar date, not an instant', async () => {
    const { service } = makeService({
      profile: { dateOfBirth: new Date('1994-03-11T00:00:00.000Z'), languageCode: 'hi' },
    });
    const view = await service.getMe(USER_ID);
    assert.equal(view.profile.dateOfBirth, '1994-03-11');
    assert.equal(view.profile.languageCode, 'hi');
  });

  it('refuses a missing or soft-deleted identity with NOT_FOUND', async () => {
    for (const user of [null, { ...USER_ROW, deletedAt: new Date() }]) {
      const { service } = makeService({ user });
      await assert.rejects(service.getMe(USER_ID), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      });
    }
  });
});
