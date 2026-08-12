import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import type { UserRepository } from '../../src/modules/auth/repositories/user.repository.js';

const phone = '+919876512001';

describe('registration provisions the profile (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function profileCreatedEvents() {
    return db().client.outboxEvent.findMany({ where: { eventType: 'user.profile.created' } });
  }

  it('creates exactly one empty profile for a newly registered account', async () => {
    const user = await loginAs(app, phone);

    const rows = await db().client.userProfile.findMany({ where: { userId: user.userId } });
    assert.equal(rows.length, 1, 'exactly one profile (USER-INV-1)');

    const profile = rows[0]!;
    assert.equal(profile.firstName, null, 'registration collects a phone number and nothing else');
    assert.equal(profile.lastName, null);
    assert.equal(profile.dateOfBirth, null);
    assert.equal(profile.gender, null);
    assert.equal(profile.profileImageFileId, null, 'no avatar until one is uploaded and attached');
    assert.equal(profile.languageCode, 'en', 'the schema default resolves (R-USER-7)');
    assert.equal(profile.referralCode, null, 'referral mints this later (USER-OD-2)');
  });

  it('announces the profile with user.profile.created, carrying only the id', async () => {
    const user = await loginAs(app, phone);

    const events = await profileCreatedEvents();
    assert.equal(events.length, 1, 'one profile, one announcement');

    const envelope = events[0]!.payload as unknown as {
      producer: string;
      subject: { userId: string };
      data: Record<string, unknown>;
    };
    assert.equal(envelope.producer, 'users', 'USER owns this event, not AUTH (doc 05 §2)');
    assert.equal(envelope.subject.userId, user.userId);
    assert.deepEqual(envelope.data, { userId: user.userId }, 'the payload is the id, nothing more');
    assert.ok(
      !JSON.stringify(envelope).includes(phone),
      'no phone number in the event (doc 05 §5)',
    );
  });

  it('serves the provisioned profile from GET /me', async () => {
    const user = await loginAs(app, phone);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: user.authHeader,
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().profile.languageCode, 'en');
  });

  it('leaves zero profiles when the registration transaction rolls back', async () => {
    const repo = container.resolve<UserRepository>('userRepository');
    const original = repo.updateLastLoginAt.bind(repo);
    repo.updateLastLoginAt = async () => {
      throw new Error('injected failure mid-transaction');
    };
    try {
      await assert.rejects(loginAs(app, phone), /otp\/verify failed/);
    } finally {
      repo.updateLastLoginAt = original;
    }

    assert.equal((await db().client.userProfile.findMany()).length, 0, 'profile rolled back');
    assert.equal((await db().client.user.findMany()).length, 0, 'account rolled back');
    assert.equal((await profileCreatedEvents()).length, 0, 'no event without its row');
  });

  it('refuses a second profile for the same account at the database level', async () => {
    const user = await loginAs(app, phone);

    await assert.rejects(
      db().client.userProfile.create({ data: { userId: user.userId } }),
      (err: Error) => {
        assert.match(err.message, /Unique constraint|user_id/i);
        return true;
      },
    );
    assert.equal((await db().client.userProfile.findMany()).length, 1);
  });

  it('does not create or announce a second profile when a returning user logs in', async () => {
    const first = await loginAs(app, phone);
    const second = await loginAs(app, phone);
    assert.equal(second.userId, first.userId, 'the same identity logs back in');

    assert.equal((await db().client.userProfile.findMany()).length, 1);
    assert.equal((await profileCreatedEvents()).length, 1, 'announced once, at creation');
  });

  it('heals an account whose profile is missing, on its next login', async () => {
    const user = await loginAs(app, phone);
    await db().client.userProfile.deleteMany({ where: { userId: user.userId } });
    await db().client.outboxEvent.deleteMany({ where: { eventType: 'user.profile.created' } });

    await loginAs(app, phone);

    assert.equal((await db().client.userProfile.findMany()).length, 1, 'the profile is restored');
    assert.equal((await profileCreatedEvents()).length, 1, 'and announced, so referral can react');
  });
});
