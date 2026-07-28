import { RedisProvider } from './RedisProvider';
import { OtpStore } from './stores/OtpStore';
import { EpochStore } from './stores/EpochStore';
import { SidBlacklistStore } from './stores/SidBlacklistStore';
import { RateLimitStore } from './stores/RateLimitStore';
import { IdempotencyStore } from './stores/IdempotencyStore';
import { LockStore } from './stores/LockStore';

/**
 * Application-facing facade over the Redis hot-state stores.
 *
 * Domain services depend on this single service and reach each concern through a
 * typed store (`redis.otp`, `redis.epoch`, …) rather than touching ioredis
 * directly — mirroring how `DatabaseService` fronts the Prisma client. Every
 * store is injected (Awilix CLASSIC resolves each constructor param by name), so
 * they are swappable in tests.
 */
export class RedisService {
  /** Connection owner — exposed for health/observability. */
  public readonly provider: RedisProvider;
  /** OTP secret + attempt/lock storage. */
  public readonly otp: OtpStore;
  /** Per-user session epoch (fast revocation). */
  public readonly epoch: EpochStore;
  /** Per-session revocation denylist. */
  public readonly sidBlacklist: SidBlacklistStore;
  /** Fixed-window rate-limit counters. */
  public readonly rateLimit: RateLimitStore;
  /** Stored-response idempotency. */
  public readonly idempotency: IdempotencyStore;
  /** Distributed locks. */
  public readonly lock: LockStore;

  /**
   * Parameter names must match their DI registration names (CLASSIC injection):
   * `redisProvider`, `otpStore`, `epochStore`, `sidBlacklistStore`,
   * `rateLimitStore`, `idempotencyStore`, `lockStore`.
   */
  constructor(
    redisProvider: RedisProvider,
    otpStore: OtpStore,
    epochStore: EpochStore,
    sidBlacklistStore: SidBlacklistStore,
    rateLimitStore: RateLimitStore,
    idempotencyStore: IdempotencyStore,
    lockStore: LockStore,
  ) {
    this.provider = redisProvider;
    this.otp = otpStore;
    this.epoch = epochStore;
    this.sidBlacklist = sidBlacklistStore;
    this.rateLimit = rateLimitStore;
    this.idempotency = idempotencyStore;
    this.lock = lockStore;
  }
}
