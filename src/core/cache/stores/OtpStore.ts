import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/** Metadata for an active OTP challenge (used for idempotent resend). */
export interface OtpChallengeMeta {
  /** Audit-trail row id returned to the client as the challenge id. */
  challengeId: string;
  /** Absolute OTP expiry, epoch milliseconds. */
  otpExpiresAt: number;
}

/** An active challenge plus the remaining resend-window seconds. */
export interface ActiveOtpChallenge extends OtpChallengeMeta {
  resendTtlSeconds: number;
}

/**
 * Redis-only storage for OTP secrets and attempt/lock accounting.
 *
 * The OTP code is never persisted to Postgres and never stored in plaintext —
 * this store holds only the pre-computed HASH supplied by the caller (the OTP
 * module owns hashing in Phase 6). It does not generate, hash, or decide
 * thresholds; TTLs and limits are passed in (auth doc 02 §4).
 */
export class OtpStore {
  private readonly client: Redis;

  /** Verifies and deletes the OTP hash in a single atomic step (single-use). */
  private static readonly CONSUME_LUA =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Store a hashed OTP for a phone+purpose with a TTL.
   * @param purpose OTP purpose (e.g. `LOGIN`).
   * @param phone E.164 phone number.
   * @param hash HMAC digest of the code (never the raw code).
   * @param ttlSeconds Code lifetime in seconds.
   */
  async store(purpose: string, phone: string, hash: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otp(purpose, phone), hash, 'EX', ttlSeconds);
  }

  /**
   * Atomically verify a presented hash against the stored one and delete on
   * match, so two concurrent verifications cannot both succeed (AUTH-INV-2).
   * @param purpose OTP purpose.
   * @param phone E.164 phone number.
   * @param presentedHash HMAC digest of the code the client supplied.
   * @returns `true` if the hash matched and was consumed; `false` otherwise.
   */
  async consume(purpose: string, phone: string, presentedHash: string): Promise<boolean> {
    const deleted = (await this.client.eval(
      OtpStore.CONSUME_LUA,
      1,
      RedisKeys.otp(purpose, phone),
      presentedHash,
    )) as number;
    return deleted === 1;
  }

  /**
   * Increment (and initialise the TTL of) the verify-attempt counter.
   * @param phone E.164 phone number.
   * @param ttlSeconds TTL applied when the counter is first created.
   * @returns The new attempt count.
   */
  async incrementAttempts(phone: string, ttlSeconds: number): Promise<number> {
    const key = RedisKeys.otpAttempts(phone);
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, ttlSeconds);
    return count;
  }

  /**
   * Read the current verify-attempt count.
   * @param phone E.164 phone number.
   * @returns The attempt count (0 if none recorded).
   */
  async getAttempts(phone: string): Promise<number> {
    const value = await this.client.get(RedisKeys.otpAttempts(phone));
    return value ? Number.parseInt(value, 10) : 0;
  }

  /**
   * Clear the attempt counter (e.g. after a successful verification).
   * @param phone E.164 phone number.
   */
  async clearAttempts(phone: string): Promise<void> {
    await this.client.del(RedisKeys.otpAttempts(phone));
  }

  /**
   * Store active-challenge metadata used to make resends idempotent. The TTL is
   * the resend window, so while it exists a repeated send returns the same
   * challenge instead of minting a new code.
   * @param purpose OTP purpose.
   * @param phone E.164 phone number.
   * @param meta Challenge id and the OTP's absolute expiry (epoch ms).
   * @param ttlSeconds Resend-window length in seconds.
   */
  async setChallenge(
    purpose: string,
    phone: string,
    meta: OtpChallengeMeta,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(
      RedisKeys.otpChallenge(purpose, phone),
      JSON.stringify(meta),
      'EX',
      ttlSeconds,
    );
  }

  /**
   * Read active-challenge metadata (for idempotent resend), with the remaining
   * resend-window seconds.
   * @param purpose OTP purpose.
   * @param phone E.164 phone number.
   * @returns The challenge plus `resendTtlSeconds`, or `null` if none is active.
   */
  async getChallenge(purpose: string, phone: string): Promise<ActiveOtpChallenge | null> {
    const key = RedisKeys.otpChallenge(purpose, phone);
    const raw = await this.client.get(key);
    if (!raw) return null;
    const ttl = await this.client.ttl(key);
    const meta = JSON.parse(raw) as OtpChallengeMeta;
    return { ...meta, resendTtlSeconds: ttl > 0 ? ttl : 0 };
  }

  /**
   * Clear active-challenge metadata (e.g. after a successful verification).
   * @param purpose OTP purpose.
   * @param phone E.164 phone number.
   */
  async clearChallenge(purpose: string, phone: string): Promise<void> {
    await this.client.del(RedisKeys.otpChallenge(purpose, phone));
  }

  /**
   * Place a lockout marker on a phone for a cooldown window.
   * @param phone E.164 phone number.
   * @param ttlSeconds Lockout duration in seconds.
   */
  async lock(phone: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otpLock(phone), '1', 'EX', ttlSeconds);
  }

  /**
   * Report whether a phone is currently locked out.
   * @param phone E.164 phone number.
   * @returns `true` if a lockout marker is present.
   */
  async isLocked(phone: string): Promise<boolean> {
    return (await this.client.exists(RedisKeys.otpLock(phone))) === 1;
  }
}
