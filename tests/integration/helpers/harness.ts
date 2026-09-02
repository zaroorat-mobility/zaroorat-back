import './load-test-env.js';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../../src/core/di.js';
import { createApp } from '../../../src/app/app.js';
import { redis } from '../../../src/core/cache/client.js';
import { closeQueues } from '../../../src/jobs/queues/index.js';
import type { DatabaseService } from '../../../src/core/database/DatabaseService.js';
import type { PrismaClientProvider } from '../../../src/core/database/client/PrismaClientProvider.js';
import type { OtpGenerator } from '../../../src/modules/auth/services/otp/otp.generator.js';
import { seedRoles } from '../../../prisma/seed/shared/roles.js';
import { seedVehicleTypes } from '../../../prisma/seed/shared/vehicle-types.js';
import { seedNotificationTemplates } from '../../../prisma/seed/shared/notification-templates.js';
import { registerEventConsumers } from '../../../src/bootstrap/events.bootstrap.js';
import type { Unsubscribe } from '../../../src/core/events/index.js';
import type { OutboxRelay } from '../../../src/core/events/OutboxRelay.js';
import { RealtimeGateway } from '../../../src/modules/realtime/index.js';

export const FIXED_OTP = '123456';

function patchOtp(): void {
  const generator = container.resolve<OtpGenerator>('otpGenerator') as unknown as {
    generate: () => string;
  };
  generator.generate = () => FIXED_OTP;
}
patchOtp();

after(async () => {
  // otp/send now enqueues, which opens a BullMQ connection of its own. No worker
  // runs in these tests: the jobs simply sit in the queue and resetState's
  // flushdb clears them.
  await closeQueues();
  await container.resolve<PrismaClientProvider>('provider').disconnect();
  await redis.quit();
});

export function db(): DatabaseService {
  return container.resolve<DatabaseService>('databaseService');
}

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('_test') && !url.includes('zaroorat_test')) {
    throw new Error(
      `resetState() refused to TRUNCATE a non-test database (${url || 'DATABASE_URL unset'}). ` +
        'Integration tests must use APP_ENV=test / .env.test.',
    );
  }
}

export async function resetState(): Promise<void> {
  assertTestDatabase();
  // `surge_zones` is here for the same reason as the two below, plus one of its
  // own: a leaked surge zone does not merely accumulate rows, it silently
  // multiplies the fare of every ride any later suite books near that point.
  // CASCADE takes `surge_windows` with it.
  //
  // `wallet_reconciliations` is in the list for the same reason
  // `payment_ledger_entries` is: its wallet id is a plain uuid column with no
  // foreign key, so TRUNCATE "users" CASCADE never reaches it. Left out, the
  // table is the one thing in the test database that survives every reset, and
  // a run's rows are still there for the next one — which turns any assertion
  // that counts reconciliation rows into a count of every run since the table
  // was created.
  await db().client.$executeRawUnsafe(
    'TRUNCATE "users", "user_profiles", "emergency_contacts", "saved_places", ' +
      '"account_deletion_requests", ' +
      '"files", "otp_verifications", "outbox_events", "vehicle_types", ' +
      '"vehicles", "vehicle_assignments", "vehicle_documents", ' +
      '"payment_ledger_entries", "gateway_events", ' +
      // The comment above already claimed `wallet_reconciliations` was here.
      // It was not, so every run's rows were still present for the next one and
      // `payment-reconciliation`'s "the driver wallet is scanned" counted every
      // run since the table was created — green on a virgin database and red
      // ever after, which is the same defect this list was extended for twice
      // before.
      '"wallet_reconciliations", ' +
      '"promotions", "promotion_redemptions", "promo_campaigns", "audience_segments", ' +
      '"campaign_targets", "coupon_batches", "coupons", "promo_banners", ' +
      '"referral_programs", "referral_codes", "referrals", "referral_rewards", ' +
      '"referral_milestones", "referral_milestone_achievements", "referral_fraud_flags", ' +
      '"billing_invoices", "invoice_templates", ' +
      // The comment above claimed `surge_zones` was already here. It was not,
      // and neither were `cities` or `service_zones` — so every city, zone and
      // surge polygon a test drew survived into every later test in the run.
      // That is not merely accumulation: a leaked city boundary decides whether
      // the pickup gate enforces or stands down (FR-048/BD-10), and a leaked
      // zone decides which rate card prices the ride. Three tests in
      // `zone-fare-parity` failed on exactly that before this line existed.
      // `states` and `countries` belong here for the same reason: nothing reset
      // them, so `admin-geographic`'s "creates a new state" passed on a virgin
      // database and failed with a unique violation on every run after — a test
      // that can only be green once is not a test.
      '"surge_zones", "service_zones", "cities", "states", "countries", ' +
      '"notification_templates", "notification_deliveries", "admin_broadcasts", "notifications" ' +
      'RESTART IDENTITY CASCADE',
  );
  // Vehicle types are reference data, like the RBAC roles — except `roles` is
  // not in the TRUNCATE list and `vehicle_types` has to be, because tests create
  // throwaway types. Re-seeding here keeps the canonical catalog present for
  // every test the way the roles table is, so GET /vehicle-types is never empty
  // and no test has to seed the platform's own catalog itself.
  await seedRoles(db().client);
  await seedVehicleTypes(db().client);
  await seedNotificationTemplates(db().client);
  await redis.flushdb();
}

export async function bootApp(): Promise<FastifyInstance> {
  const app = await createApp();
  await app.ready();
  return app;
}

export interface LoggedInUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  authHeader: { authorization: string };
}

export async function loginAs(app: FastifyInstance, phoneNumber: string): Promise<LoggedInUser> {
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/send',
    payload: { phoneNumber },
  });
  if (sent.statusCode !== 200) throw new Error(`otp/send failed: ${sent.payload}`);

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    headers: { 'idempotency-key': randomUUID() },
    payload: { phoneNumber, code: FIXED_OTP, challengeId: sent.json().challengeId },
  });
  if (verified.statusCode !== 200) throw new Error(`otp/verify failed: ${verified.payload}`);

  const body = verified.json();
  return {
    userId: body.user.id,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    authHeader: { authorization: `Bearer ${body.accessToken}` },
  };
}

/// Subscribes every production event consumer to the bus, and returns the
/// handle that tears them down again.
///
/// This is the whole point of splitting `registerEventConsumers` out of
/// `bootstrapEvents`: consumer registration is pure, so a test can have the real
/// consumers wired without also starting the outbox relay's polling loop, an
/// HTTP listener, or any BullMQ worker. Drive delivery with
/// `outboxRelay.processBatch()` at the point a deployment's relay would.
export function bootEventConsumers(): Unsubscribe {
  return registerEventConsumers();
}

/// Relays committed outbox rows to the bus, the way the running relay would,
/// and keeps going until nothing new appears.
///
/// One pass is not enough: a consumer often publishes while handling — the
/// dispatch consumer writes `ride.dispatch.offered` in response to
/// `ride.requested` — and that row lands after the batch that triggered it. A
/// real relay polls on a loop and picks it up; this reproduces that.
export async function drainOutbox(limit = 200): Promise<number> {
  const relay = container.resolve<OutboxRelay>('outboxRelay');
  let total = 0;
  // Bounded so a consumer that publishes what it consumes cannot spin forever.
  for (let pass = 0; pass < 10; pass++) {
    const { published } = await relay.processBatch(limit);
    if (published === 0) break;
    total += published;
  }
  return total;
}

export interface ListeningApp {
  app: FastifyInstance;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/// A Fastify instance on a real ephemeral port with the socket gateway attached.
/// `app.inject()` never binds a port, so socket tests — which need a genuine
/// client connection — cannot use `bootApp()`.
export async function bootListeningApp(): Promise<ListeningApp> {
  const app = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const gateway = container.resolve<RealtimeGateway>('realtimeGateway');
  gateway.attach(app.server);
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    app,
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await gateway.close();
      await app.close();
    },
  };
}
