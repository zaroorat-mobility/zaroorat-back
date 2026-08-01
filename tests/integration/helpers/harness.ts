import { randomUUID } from 'node:crypto';
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
 * Truncate the auth and user tables and flush the test Redis db between tests.
 * `users` is truncated with CASCADE, which clears every dependent row (sessions,
 * tokens, devices, role assignments, profiles, contacts, places); seeded `roles`
 * are preserved. The USER tables are named explicitly even though CASCADE
 * already reaches them — an explicit reset list is one less thing to reason
 * about when a test leaks state (user doc 06 §2).
 *
 * `vehicle_types` is named because it does **not** reference `users` and so is not
 * reached by the cascade; the departure suite seeds one to build the ride that
 * blocks a deactivation (R-USER-21).
 */
export async function resetState(): Promise<void> {
  await db().client.$executeRawUnsafe(
    'TRUNCATE "users", "user_profiles", "emergency_contacts", "saved_places", ' +
      '"otp_verifications", "outbox_events", "vehicle_types" RESTART IDENTITY CASCADE',
  );
  await redis.flushdb();
}

/** Boot the app and wait until it is ready to accept injected requests. */
export async function bootApp(): Promise<FastifyInstance> {
  const app = await createApp();
  await app.ready();
  return app;
}

/** An authenticated caller: the account it belongs to plus its live credentials. */
export interface LoggedInUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Ready-made `Authorization` header for `app.inject`. */
  authHeader: { authorization: string };
}

/**
 * Register (or log back in to) an account and return its credentials.
 *
 * Every USER test starts authenticated, so this runs the real OTP send/verify
 * flow rather than minting a token directly — a test that fakes its own token
 * would not exercise the deny-by-default gate the whole module depends on
 * (user doc 06 §2).
 *
 * @param app The booted app.
 * @param phoneNumber E.164 number to register/log in.
 * @returns The account id and a usable token pair.
 */
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
