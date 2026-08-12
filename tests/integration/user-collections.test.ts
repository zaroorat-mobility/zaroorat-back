import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { userConfig } from '../../src/config/user/index.js';
import type { EventPublisher } from '../../src/core/events/EventPublisher.js';

const OWNER = '+919876514001';
const STRANGER = '+919876514002';

const CONTACTS = '/api/v1/users/me/emergency-contacts';
const PLACES = '/api/v1/users/me/saved-places';

describe('emergency contacts and saved places (integration)', () => {
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

  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    user: LoggedInUser,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: user.authHeader,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  async function addContact(user: LoggedInUser, overrides: Record<string, unknown> = {}) {
    const response = await call('POST', CONTACTS, user, {
      contactName: 'Priya',
      phoneNumber: '+919876500042',
      ...overrides,
    });
    assert.equal(response.statusCode, 201, response.payload);
    return response.json();
  }

  async function addPlace(user: LoggedInUser, overrides: Record<string, unknown> = {}) {
    const response = await call('POST', PLACES, user, { label: 'Home', ...overrides });
    assert.equal(response.statusCode, 201, response.payload);
    return response.json();
  }

  async function events(eventType: string) {
    const rows = await db().client.outboxEvent.findMany({ where: { eventType } });
    return rows.map((row) => row.payload as unknown as { data: Record<string, unknown> });
  }

  describe('emergency contacts', () => {
    it('creates, lists, edits, and removes a contact', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addContact(user, { relationship: 'SPOUSE', priority: 2 });

      assert.equal(created.contactName, 'Priya');
      assert.equal(created.priority, 2);
      assert.ok(!('userId' in created), 'the owner is the caller; echoing it says nothing');

      const listed = await call('GET', CONTACTS, user);
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), [created]);

      const edited = await call('PATCH', `${CONTACTS}/${created.id}`, user, { priority: 1 });
      assert.equal(edited.statusCode, 200, edited.payload);
      assert.equal(edited.json().priority, 1);
      assert.equal(edited.json().contactName, 'Priya', 'an omitted key is unchanged');

      const removed = await call('DELETE', `${CONTACTS}/${created.id}`, user);
      assert.equal(removed.statusCode, 204);
      assert.deepEqual((await call('GET', CONTACTS, user)).json(), []);
    });

    it('lists in priority order, with a stable tie-break (R-USER-23)', async () => {
      const user = await loginAs(app, OWNER);
      await addContact(user, { contactName: 'Third', priority: 3 });
      await addContact(user, { contactName: 'First', priority: 1 });
      const tied = await addContact(user, { contactName: 'AlsoFirst', priority: 1 });

      const listed = (await call('GET', CONTACTS, user)).json() as { priority: number }[];
      assert.deepEqual(
        listed.map((c) => c.priority),
        [1, 1, 3],
        '`sos` notifies in this order',
      );

      const again = (await call('GET', CONTACTS, user)).json() as { id: string }[];
      assert.deepEqual(
        again.map((c) => c.id),
        (listed as unknown as { id: string }[]).map((c) => c.id),
      );
      assert.ok(again.some((c) => c.id === tied.id));
    });

    it('clears relationship on an explicit null and leaves it on an absent key', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addContact(user, { relationship: 'SPOUSE' });

      const untouched = await call('PATCH', `${CONTACTS}/${created.id}`, user, { priority: 4 });
      assert.equal(untouched.json().relationship, 'SPOUSE');

      const cleared = await call('PATCH', `${CONTACTS}/${created.id}`, user, {
        relationship: null,
      });
      assert.equal(cleared.json().relationship, null);
    });

    it('refuses the cap+1st contact with the cap in details (R-USER-22/26)', async () => {
      const user = await loginAs(app, OWNER);
      for (let i = 0; i < userConfig.maxEmergencyContacts; i += 1) {
        await addContact(user, { contactName: `Contact ${i}` });
      }

      const overflow = await call('POST', CONTACTS, user, {
        contactName: 'One too many',
        phoneNumber: '+919876500099',
      });
      assert.equal(overflow.statusCode, 409);
      const error = overflow.json().error;
      assert.equal(error.code, 'LIMIT_EXCEEDED');

      assert.deepEqual(error.details, [
        {
          field: 'emergencyContacts',
          code: 'LIMIT_EXCEEDED',
          limit: userConfig.maxEmergencyContacts,
        },
      ]);
    });

    it('emits added/updated/removed with identifiers only (doc 05 §3.4)', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addContact(user, { relationship: 'SPOUSE', priority: 2 });
      await call('PATCH', `${CONTACTS}/${created.id}`, user, { priority: 1 });
      await call('DELETE', `${CONTACTS}/${created.id}`, user);

      assert.deepEqual((await events('user.emergency_contact.added'))[0]?.data, {
        userId: user.userId,
        contactId: created.id,
        priority: 2,
      });
      assert.deepEqual((await events('user.emergency_contact.updated'))[0]?.data, {
        userId: user.userId,
        contactId: created.id,
        changedFields: ['priority'],
      });
      assert.deepEqual((await events('user.emergency_contact.removed'))[0]?.data, {
        userId: user.userId,
        contactId: created.id,
      });

      const all = await db().client.outboxEvent.findMany();
      const payloads = JSON.stringify(all.map((row) => row.payload));
      assert.ok(!payloads.includes('Priya'), 'no contact name in any event');
      assert.ok(!payloads.includes('+919876500042'), 'no contact number in any event');
    });
  });

  describe('saved places', () => {
    it('creates, lists, edits, and removes a place', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addPlace(user, {
        address: '12 MG Road, Bengaluru',
        landmark: 'opposite the metro station',
        instructions: 'Call on arrival',
        latitude: 12.9716,
        longitude: 77.5946,
      });

      assert.equal(created.label, 'Home');
      assert.equal(created.latitude, 12.9716, 'decimals come back as numbers');
      assert.equal(created.longitude, 77.5946);

      const edited = await call('PATCH', `${PLACES}/${created.id}`, user, { floor: '3B' });
      assert.equal(edited.statusCode, 200, edited.payload);
      assert.equal(edited.json().floor, '3B');
      assert.equal(edited.json().address, '12 MG Road, Bengaluru', 'an omitted key is unchanged');

      assert.equal((await call('DELETE', `${PLACES}/${created.id}`, user)).statusCode, 204);
      assert.deepEqual((await call('GET', PLACES, user)).json(), []);
    });

    it('lists by label, case-insensitively (doc 02 §2.6)', async () => {
      const user = await loginAs(app, OWNER);
      for (const label of ['work', 'Airport', 'home']) await addPlace(user, { label });

      const listed = (await call('GET', PLACES, user)).json() as { label: string }[];
      assert.deepEqual(
        listed.map((p) => p.label),
        ['Airport', 'home', 'work'],
        'the client renders the list as received',
      );
    });

    it('refuses a label that differs only in case (409 CONFLICT)', async () => {
      const user = await loginAs(app, OWNER);
      await addPlace(user, { label: 'home' });

      const clash = await call('POST', PLACES, user, { label: 'Home' });
      assert.equal(clash.statusCode, 409);
      assert.equal(clash.json().error.code, 'CONFLICT');

      const other = await addPlace(user, { label: 'Work' });
      const renamed = await call('PATCH', `${PLACES}/${other.id}`, user, { label: 'HOME' });
      assert.equal(renamed.statusCode, 409);
      assert.equal(renamed.json().error.code, 'CONFLICT');
    });

    it('lets two different users hold the same label', async () => {
      const user = await loginAs(app, OWNER);
      const stranger = await loginAs(app, STRANGER);
      await addPlace(user, { label: 'Home' });
      await addPlace(stranger, { label: 'Home' });

      assert.equal((await call('GET', PLACES, user)).json().length, 1);
      assert.equal((await call('GET', PLACES, stranger)).json().length, 1);
    });

    it('refuses the cap+1st place', async () => {
      const user = await loginAs(app, OWNER);
      for (let i = 0; i < userConfig.maxSavedPlaces; i += 1) {
        await addPlace(user, { label: `Place ${i}` });
      }

      const overflow = await call('POST', PLACES, user, { label: 'One too many' });
      assert.equal(overflow.statusCode, 409);
      assert.equal(overflow.json().error.code, 'LIMIT_EXCEEDED');
      assert.equal(overflow.json().error.details[0].limit, userConfig.maxSavedPlaces);
    });

    it('derives the geography with longitude first (doc 03 §4.4)', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addPlace(user, { latitude: 12.9716, longitude: 77.5946 });

      const [point] = await db().client.$queryRaw<{ lng: number; lat: number }[]>`
        SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
          FROM saved_places WHERE id = ${created.id}::uuid`;

      assert.ok(Math.abs(point!.lat - 12.9716) < 1e-6, `latitude was ${point!.lat}`);
      assert.ok(Math.abs(point!.lng - 77.5946) < 1e-6, `longitude was ${point!.lng}`);
    });

    it('moves and clears the geography with the coordinates', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addPlace(user, { latitude: 12.9716, longitude: 77.5946 });

      await call('PATCH', `${PLACES}/${created.id}`, user, {
        latitude: 28.6139,
        longitude: 77.209,
      });
      const [moved] = await db().client.$queryRaw<{ lat: number }[]>`
        SELECT ST_Y(location::geometry) AS lat FROM saved_places WHERE id = ${created.id}::uuid`;
      assert.ok(Math.abs(moved!.lat - 28.6139) < 1e-6, 'the derived point followed the decimals');

      const cleared = await call('PATCH', `${PLACES}/${created.id}`, user, {
        latitude: null,
        longitude: null,
      });
      assert.equal(cleared.json().latitude, null);
      const [gone] = await db().client.$queryRaw<{ present: boolean }[]>`
        SELECT location IS NOT NULL AS present FROM saved_places WHERE id = ${created.id}::uuid`;
      assert.equal(gone!.present, false, 'a cleared pair leaves no stale point behind');
    });

    it('emits the label but never an address or a coordinate (doc 05 §3.4)', async () => {
      const user = await loginAs(app, OWNER);
      const created = await addPlace(user, {
        address: '12 MG Road, Bengaluru',
        landmark: 'opposite the metro station',
        instructions: 'Call on arrival',
        latitude: 12.9716,
        longitude: 77.5946,
      });
      await call('PATCH', `${PLACES}/${created.id}`, user, { floor: '3B' });

      assert.deepEqual((await events('user.saved_place.added'))[0]?.data, {
        userId: user.userId,
        placeId: created.id,
        label: 'Home',
      });
      assert.deepEqual((await events('user.saved_place.updated'))[0]?.data, {
        userId: user.userId,
        placeId: created.id,
        changedFields: ['floor'],
      });

      const payloads = JSON.stringify(
        (await db().client.outboxEvent.findMany()).map((row) => row.payload),
      );
      for (const secret of ['MG Road', 'metro station', 'Call on arrival', '12.9716', '77.5946']) {
        assert.ok(!payloads.includes(secret), `"${secret}" reached an event payload`);
      }
    });
  });

  describe('ownership (USER-INV-2, R-USER-25)', () => {
    it('answers 404 — never 403 — for every route on another user’s item', async () => {
      const user = await loginAs(app, OWNER);
      const stranger = await loginAs(app, STRANGER);
      const contact = await addContact(user);
      const place = await addPlace(user);

      const routes = [
        ['PATCH', `${CONTACTS}/${contact.id}`, { priority: 9 }],
        ['DELETE', `${CONTACTS}/${contact.id}`, undefined],
        ['PATCH', `${PLACES}/${place.id}`, { label: 'Stolen' }],
        ['DELETE', `${PLACES}/${place.id}`, undefined],
      ] as const;

      for (const [method, url, payload] of routes) {
        const response = await call(method, url, stranger, payload);
        assert.equal(response.statusCode, 404, `${method} ${url}`);
        assert.equal(response.json().error.code, 'NOT_FOUND', `${method} ${url}`);
      }

      assert.equal((await call('GET', CONTACTS, user)).json()[0].priority, 1);
      assert.equal((await call('GET', PLACES, user)).json()[0].label, 'Home');
    });

    it('makes another user’s id byte-identical to one that never existed', async () => {
      const user = await loginAs(app, OWNER);
      const stranger = await loginAs(app, STRANGER);
      const contact = await addContact(user);

      const owned = await call('DELETE', `${CONTACTS}/${contact.id}`, stranger);
      const absent = await call('DELETE', `${CONTACTS}/${randomUUID()}`, stranger);

      const strip = (raw: string) => {
        const body = JSON.parse(raw) as { error: Record<string, unknown> };
        delete body.error.requestId;
        return body;
      };
      assert.equal(owned.statusCode, absent.statusCode);
      assert.deepEqual(strip(owned.payload), strip(absent.payload));
    });

    it('never lists another user’s items', async () => {
      const user = await loginAs(app, OWNER);
      const stranger = await loginAs(app, STRANGER);
      await addContact(user);
      await addPlace(user);

      assert.deepEqual((await call('GET', CONTACTS, stranger)).json(), []);
      assert.deepEqual((await call('GET', PLACES, stranger)).json(), []);
    });

    it('is closed to unauthenticated callers on every route', async () => {
      const urls = [CONTACTS, `${CONTACTS}/${randomUUID()}`, PLACES, `${PLACES}/${randomUUID()}`];
      for (const url of urls) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
          const response = await app.inject({ method, url, payload: {} });

          if (response.statusCode === 404 && response.json().error === undefined) continue;
          assert.equal(response.statusCode, 401, `${method} ${url}`);
          assert.equal(response.json().error.code, 'TOKEN_INVALID', `${method} ${url}`);
        }
      }
    });

    it('rejects a malformed id before it reaches a query', async () => {
      const user = await loginAs(app, OWNER);
      const response = await call('DELETE', `${CONTACTS}/not-a-uuid`, user);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json().error.details, [{ field: 'id', code: 'INVALID_FORMAT' }]);
    });
  });

  it('holds the cap under concurrent creates (USER-INV-7)', async () => {
    const user = await loginAs(app, OWNER);
    const cap = userConfig.maxEmergencyContacts;

    const attempts = Array.from({ length: cap + 5 }, (_, i) =>
      call('POST', CONTACTS, user, { contactName: `Racer ${i}`, phoneNumber: '+919876500042' }),
    );
    const responses = await Promise.all(attempts);

    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    assert.equal(created.length, cap, 'exactly the cap was admitted');
    assert.equal(refused.length, 5, 'and every other caller was told the collection is full');

    const rows = await db().client.emergencyContact.count({ where: { userId: user.userId } });
    assert.equal(rows, cap, 'the database agrees');
  });

  it('rolls the row back when its event cannot be written (doc 05 §4)', async () => {
    const user = await loginAs(app, OWNER);
    const publisher = container.resolve<EventPublisher>('eventPublisher') as unknown as {
      publish: (...args: unknown[]) => Promise<void>;
    };
    const original = publisher.publish.bind(publisher);
    publisher.publish = async () => {
      throw new Error('outbox unavailable');
    };

    try {
      const response = await call('POST', PLACES, user, { label: 'Home' });
      assert.equal(response.statusCode, 500, 'the change fails with the event it could not record');
    } finally {
      publisher.publish = original;
    }

    assert.equal(await db().client.savedPlace.count({ where: { userId: user.userId } }), 0);
    assert.equal(
      (await db().client.outboxEvent.findMany({ where: { eventType: 'user.saved_place.added' } }))
        .length,
      0,
      'no half-written pair in either direction',
    );
  });

  describe('the doc 03 §5 schema objects', () => {
    it('ships all four indexes, with the geospatial one on GiST', async () => {
      const rows = await db().client.$queryRaw<{ indexname: string; amname: string }[]>`
        SELECT i.relname AS indexname, am.amname
          FROM pg_class i
          JOIN pg_index x ON x.indexrelid = i.oid
          JOIN pg_am am ON am.oid = i.relam
         WHERE i.relname IN (
           'ix_emergency_contacts_user', 'ix_saved_places_user',
           'uq_saved_places_user_label', 'ix_emergency_contacts_priority',
           'ix_saved_places_location'
         )`;
      const byName = new Map(rows.map((row) => [row.indexname, row.amname]));

      for (const name of [
        'ix_emergency_contacts_user',
        'ix_saved_places_user',
        'uq_saved_places_user_label',
        'ix_emergency_contacts_priority',
      ]) {
        assert.ok(byName.has(name), `${name} is missing`);
      }
      assert.equal(byName.get('ix_saved_places_location'), 'gist', 'the geospatial index is GiST');
    });

    it('makes the label uniqueness the database’s job, not the service’s', async () => {
      const user = await loginAs(app, OWNER);
      await addPlace(user, { label: 'home' });

      await assert.rejects(
        db().client.savedPlace.create({ data: { userId: user.userId, label: 'HOME' } }),
        /Unique constraint|uq_saved_places_user_label/i,
      );
    });
  });
});
