import type { FastifyInstance } from 'fastify';

import { container } from '../../../src/core/di.js';
import { createApp } from '../../../src/app/app.js';
import { redis } from '../../../src/core/cache/client.js';
import type { DatabaseService } from '../../../src/core/database/DatabaseService.js';
import type { OtpGenerator } from '../../../src/modules/auth/otp/otp.generator.js';

/**
 * Integration harness: boots the real Fastify app against the live test Postgres
 * + Redis (see `.env.test`). Requires `APP_ENV=test` and running services — the
 * CI `test` job and the local docker-compose stack both provide them.
 */

/** The fixed OTP every integration test verifies against (see {@link patchOtp}). */
export const FIXED_OTP = '123456';

// Make OTP delivery deterministic without touching production code: mutate the
// singleton generator instance the OtpService already holds a reference to, so
// `generate()` always returns FIXED_OTP regardless of resolution order.
function patchOtp(): void {
  const generator = container.resolve<OtpGenerator>('otpGenerator') as unknown as {
    generate: () => string;
  };
  generator.generate = () => FIXED_OTP;
}
patchOtp();

/** The Prisma-backed database service (for direct row assertions). */
export function db(): DatabaseService {
  return container.resolve<DatabaseService>('databaseService');
}

/**
 * Truncate the auth tables and flush the test Redis db between tests. `users` is
 * truncated with CASCADE, which clears every dependent row (sessions, tokens,
 * devices, role assignments); seeded `roles` are preserved.
 */
export async function resetState(): Promise<void> {
  await db().client.$executeRawUnsafe(
    'TRUNCATE "users", "otp_verifications", "outbox_events" RESTART IDENTITY CASCADE',
  );
  await redis.flushdb();
}

/** Boot the app and wait until it is ready to accept injected requests. */
export async function bootApp(): Promise<FastifyInstance> {
  const app = await createApp();
  await app.ready();
  return app;
}
