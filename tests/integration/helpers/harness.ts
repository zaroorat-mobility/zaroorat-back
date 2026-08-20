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

export async function resetState(): Promise<void> {
  await db().client.$executeRawUnsafe(
    'TRUNCATE "users", "user_profiles", "emergency_contacts", "saved_places", ' +
      '"account_deletion_requests", ' +
      '"files", "otp_verifications", "outbox_events", "vehicle_types", ' +
      '"payment_ledger_entries", "gateway_events" RESTART IDENTITY CASCADE',
  );
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
