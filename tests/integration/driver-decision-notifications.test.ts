import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { driverConfig } from '../../src/config/driver/driver.config.js';
import type {
  EventBus,
  OutboxRelay,
  OutboxRepository,
  Unsubscribe,
} from '../../src/core/events/index.js';
import type {
  SmsMessage,
  SmsProvider,
  SmsSendResult,
} from '../../src/modules/notifications/providers/sms.provider.js';

/// Application decisions text the driver through the transactional outbox: the decision,
/// its audit row and the outbox event commit together, and the SMS goes out only when the
/// relay delivers the committed event. Every assertion runs the relay by hand, so nothing
/// here depends on timers.
describe('driver application decision SMS (transactional outbox)', () => {
  let app: FastifyInstance;
  let unsubscribe: Unsubscribe | null = null;
  let sms: { sent: SmsMessage[]; restore: () => void };

  const relay = () => container.resolve<OutboxRelay>('outboxRelay');
  const outbox = () => container.resolve<OutboxRepository>('outboxRepository');

  before(async () => {
    app = await bootApp();
    if (container.hasRegistration('driverDecisionSmsConsumer')) {
      unsubscribe = container
        .resolve<{ register(): Unsubscribe }>('driverDecisionSmsConsumer')
        .register();
    }
  });
  after(async () => {
    unsubscribe?.();
    await app.close();
  });
  beforeEach(() => {
    sms = scriptSms([]);
  });
  afterEach(async () => {
    sms.restore();
    await resetState();
  });

  /// Wraps the shared SMS provider: records every message and answers from `script` in
  /// order, accepting once the script runs out.
  function scriptSms(script: Array<Partial<SmsSendResult>>) {
    const provider = container.resolve<SmsProvider>('smsProvider');
    const sent: SmsMessage[] = [];
    (provider as { sendSms: SmsProvider['sendSms'] }).sendSms = async (message) => {
      sent.push(message);
      return {
        accepted: true,
        provider: 'mock',
        providerRef: `ref-${sent.length}`,
        ...script.shift(),
      };
    };
    return { sent, restore: () => void Reflect.deleteProperty(provider, 'sendSms') };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const textsTo = (phone: string) => sms.sent.filter((m) => m.to === phone);

  async function admin(phone: string): Promise<LoggedInUser> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'admin');
    return loginAs(app, phone);
  }

  async function pendingDriver(phone: string, verifiedLicence = false) {
    const user = await loginAs(app, phone);
    const driverId = await makeDriver(user.userId, { verified: false });
    if (verifiedLicence) {
      for (const documentType of driverConfig.requiredDocumentTypes) {
        await db().client.driverDocument.create({
          data: {
            driverId,
            documentType,
            verificationStatus: 'VERIFIED',
            fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
          },
        });
      }
    }
    return { user, driverId, phone };
  }

  function decide(
    who: LoggedInUser,
    driverId: string,
    decision: 'approve' | 'reject' | 'request-resubmission',
    notes: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${driverId}/${decision}`,
      headers: who.authHeader,
      payload: { notes },
    });
  }

  const outboxRows = (eventType: string) =>
    db().client.outboxEvent.findMany({ where: { eventType }, orderBy: { createdAt: 'asc' } });

  async function ledgerFor(eventType: string) {
    const [row] = await outboxRows(eventType);
    assert.ok(row, `outbox row for ${eventType}`);
    const eventId = (row.payload as { eventId: string }).eventId;
    return db().client.notification.findUnique({
      where: { idempotencyKey: `sms:${eventId}` },
      include: { deliveries: true },
    });
  }

  it('sends nothing before the rejection commits, then exactly one SMS once relayed', async () => {
    const ops = await admin('+919876560001');
    const { driverId, phone } = await pendingDriver('+919876560002');

    const response = await decide(ops, driverId, 'reject', 'Licence photo is unreadable');
    assert.equal(response.statusCode, 200, response.payload);

    // Decision, audit row and outbox event committed together.
    const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
    assert.equal(driver.verificationStatus, 'REJECTED');
    const audit = await db().client.adminActivityLog.count({
      where: { entityType: 'driver', entityId: driverId, action: 'REJECT' },
    });
    assert.equal(audit, 1);
    assert.equal((await outboxRows('driver.verification_rejected')).length, 1);

    await settle();
    assert.equal(textsTo(phone).length, 0, 'no SMS may leave before the relay delivers the event');

    await relay().processBatch(100);
    assert.equal(textsTo(phone).length, 1);
    const ledger = await ledgerFor('driver.verification_rejected');
    assert.equal(ledger?.status, 'SENT');
    assert.deepEqual(
      ledger?.deliveries.map((d) => [d.channel, d.status, d.recipient]),
      [['SMS', 'SENT', phone]],
    );
  });

  it('sends nothing for a decision that fails at commit, and leaves no audit or outbox trace', async () => {
    const ops = await admin('+919876560003');
    const { driverId, phone } = await pendingDriver('+919876560004');
    // Refuses the transaction at COMMIT, after every statement in it has run.
    await db().client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rejection_reason = 'REFUSE AT COMMIT' THEN
          RAISE EXCEPTION 'commit refused by test';
        END IF;
        RETURN NEW;
      END $$`);
    await db().client.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER test_refuse_commit AFTER UPDATE ON drivers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_refuse_commit()`);
    try {
      const response = await decide(ops, driverId, 'reject', 'REFUSE AT COMMIT');
      assert.ok(response.statusCode >= 500, `${response.statusCode} ${response.payload}`);

      await settle();
      await relay().processBatch(100);
      assert.equal(textsTo(phone).length, 0);
      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.verificationStatus, 'PENDING');
      assert.equal((await outboxRows('driver.verification_rejected')).length, 0);
      assert.equal(
        await db().client.adminActivityLog.count({
          where: { entityType: 'driver', entityId: driverId },
        }),
        0,
      );
    } finally {
      await db().client.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_refuse_commit ON drivers');
      await db().client.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_refuse_commit()');
    }
  });

  it('retries a transient provider failure with backoff and sends once it recovers', async () => {
    sms.restore();
    sms = scriptSms([{ accepted: false, retryable: true, error: 'HTTP 503' }]);
    const ops = await admin('+919876560005');
    const { driverId, phone } = await pendingDriver('+919876560006');
    await decide(ops, driverId, 'reject', 'Expired licence');

    const before = Date.now();
    await relay().processBatch(100);
    assert.equal(textsTo(phone).length, 1);
    const [retrying] = await outboxRows('driver.verification_rejected');
    assert.equal(retrying?.status, 'PENDING');
    assert.equal(retrying?.retries, 1);
    assert.ok(retrying!.nextAttemptAt.getTime() >= before, 'the retry is scheduled, not immediate');
    const queued = await ledgerFor('driver.verification_rejected');
    assert.deepEqual(
      queued?.deliveries.map((d) => [d.status, d.attempts]),
      [['QUEUED', 1]],
    );

    // The push reconciliation sweep leaves the queued SMS to its outbox retry.
    const stale = await container
      .resolve<{
        findStaleQueuedNotifications(before: Date, limit: number): Promise<Array<{ id: string }>>;
      }>('notificationRepository')
      .findStaleQueuedNotifications(new Date(Date.now() + 60_000), 100);
    assert.ok(!stale.some((row) => row.id === queued!.id));

    // The backoff elapses.
    await db().client.outboxEvent.update({
      where: { id: retrying!.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await relay().processBatch(100);
    assert.equal(textsTo(phone).length, 2);
    const sent = await ledgerFor('driver.verification_rejected');
    assert.deepEqual(
      sent?.deliveries.map((d) => [d.status, d.attempts]),
      [['SENT', 2]],
    );
    const [published] = await outboxRows('driver.verification_rejected');
    assert.equal(published?.status, 'PUBLISHED');
  });

  it('does not send while another attempt holds the delivery, and retries instead', async () => {
    sms.restore();
    sms = scriptSms([{ accepted: false, retryable: true, error: 'HTTP 503' }]);
    const ops = await admin('+919876560018');
    const { driverId, phone } = await pendingDriver('+919876560019');
    await decide(ops, driverId, 'reject', 'Unreadable');
    await relay().processBatch(100);
    const ledger = await ledgerFor('driver.verification_rejected');
    const deliveryId = ledger!.deliveries[0]!.id;

    // A concurrent attempt (another relay that reclaimed the event) takes the send lease.
    const held = await db().client.$queryRaw<Array<{ attempts: number }>>`
      UPDATE notification_deliveries
      SET attempts = attempts + 1,
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{leaseUntil}',
                               to_jsonb(now() + interval '1 minute'))
      WHERE id = ${deliveryId}::uuid RETURNING attempts`;
    assert.equal(held.length, 1);
    const [row] = await outboxRows('driver.verification_rejected');
    await db().client.outboxEvent.update({
      where: { id: row!.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await relay().processBatch(100);

    assert.equal(textsTo(phone).length, 1, 'only the first, failed attempt reached the provider');
    const [retried] = await outboxRows('driver.verification_rejected');
    assert.equal(retried?.status, 'PENDING');
    assert.equal(retried?.retries, 2);
  });

  it('records a permanent provider refusal without retrying it', async () => {
    sms.restore();
    sms = scriptSms([{ accepted: false, retryable: false, error: 'invalid destination' }]);
    const ops = await admin('+919876560007');
    const { driverId, phone } = await pendingDriver('+919876560008');
    await decide(ops, driverId, 'reject', 'Wrong documents');

    await relay().processBatch(100);
    await relay().processBatch(100);

    assert.equal(textsTo(phone).length, 1);
    const ledger = await ledgerFor('driver.verification_rejected');
    assert.equal(ledger?.status, 'FAILED');
    assert.equal(ledger?.deliveries[0]?.status, 'FAILED');
    const [row] = await outboxRows('driver.verification_rejected');
    assert.equal(row?.status, 'PUBLISHED');
  });

  it('recovers an event whose relay died mid-dispatch', async () => {
    const ops = await admin('+919876560009');
    const { driverId, phone } = await pendingDriver('+919876560010');
    await decide(ops, driverId, 'reject', 'Blurry photo');

    // A relay claims the batch and dies before dispatching it.
    const claimed = await outbox().claimBatch(100);
    assert.ok(claimed.some((row) => row.eventType === 'driver.verification_rejected'));
    await relay().processBatch(100);
    assert.equal(textsTo(phone).length, 0, 'a claimed row is not delivered twice concurrently');

    // The next relay's maintenance reclaims the stale claim.
    await outbox().reclaimStale(new Date(Date.now() + 1000));
    await relay().processBatch(100);
    assert.equal(textsTo(phone).length, 1);
  });

  it('never texts twice for one decision: repeated requests, redelivery or a re-run handler', async () => {
    const ops = await admin('+919876560011');
    const { driverId, phone } = await pendingDriver('+919876560012');
    await decide(ops, driverId, 'reject', 'Mismatched name');
    const repeat = await decide(ops, driverId, 'reject', 'Mismatched name');
    assert.equal(repeat.statusCode, 200, repeat.payload);
    assert.equal((await outboxRows('driver.verification_rejected')).length, 1);

    // Another subscriber fails once, so the relay redelivers the whole event.
    let failures = 1;
    const off = container.resolve<EventBus>('eventBus').on('driver.verification_rejected', () => {
      if (failures-- > 0) throw new Error('sibling subscriber failed');
    });
    try {
      await relay().processBatch(100);
      const [row] = await outboxRows('driver.verification_rejected');
      assert.equal(row?.retries, 1, 'the event was redelivered');
      await db().client.outboxEvent.update({
        where: { id: row!.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await relay().processBatch(100);
      // And the same envelope handed to the bus once more.
      await container.resolve<EventBus>('eventBus').emit(row!.payload as never);
    } finally {
      off();
    }

    assert.equal(textsTo(phone).length, 1);
  });

  it('texts approvals and resubmission requests through their own templates, after commit', async () => {
    const ops = await admin('+919876560013');
    const approved = await pendingDriver('+919876560014', true);
    const sentBack = await pendingDriver('+919876560015');

    assert.equal((await decide(ops, approved.driverId, 'approve', 'All clear')).statusCode, 200);
    const resubmit = await decide(ops, sentBack.driverId, 'request-resubmission', 'Retake the RC');
    assert.equal(resubmit.statusCode, 200, resubmit.payload);
    await settle();
    assert.equal(sms.sent.length, 0);

    await relay().processBatch(100);
    assert.equal(textsTo(approved.phone).length, 1);
    assert.equal(textsTo(sentBack.phone).length, 1);
    assert.match(textsTo(approved.phone)[0]!.body, /activated/i);
    assert.match(textsTo(sentBack.phone)[0]!.body, /re-?upload|resubmit/i);
  });

  it('queues one push per decision, however often the event is delivered', async () => {
    const ops = await admin('+919876560018');
    const approved = await pendingDriver('+919876560019', true);
    assert.equal((await decide(ops, approved.driverId, 'approve', 'All clear')).statusCode, 200);

    await relay().processBatch(100);
    const [row] = await outboxRows('driver.verified');
    await container.resolve<EventBus>('eventBus').emit(row!.payload as never);

    const pushes = await db().client.notification.findMany({
      where: { userId: approved.user.userId, deliveries: { some: { channel: 'PUSH' } } },
    });
    assert.deepEqual(
      pushes.map((n) => [n.eventKey, n.idempotencyKey, n.title]),
      [
        [
          'driver.verified',
          `push:${(row!.payload as { eventId: string }).eventId}`,
          'Application approved',
        ],
      ],
    );
    assert.equal(textsTo(approved.phone).length, 1, 'the SMS still goes, once');
  });

  it('does not tell a finally rejected driver to resubmit', async () => {
    const ops = await admin('+919876560016');
    const { driverId, phone } = await pendingDriver('+919876560017');
    await decide(ops, driverId, 'reject', 'Fraudulent licence');

    await relay().processBatch(100);

    const [text] = textsTo(phone);
    assert.ok(text, 'the driver is told');
    assert.doesNotMatch(text.body, /re-?upload|resubmit/i);
  });
});
