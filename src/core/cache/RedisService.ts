import { RedisProvider } from './RedisProvider';
import { OtpStore } from './stores/OtpStore';
import { EpochStore } from './stores/EpochStore';
import { SidBlacklistStore } from './stores/SidBlacklistStore';
import { RateLimitStore } from './stores/RateLimitStore';
import { IdempotencyStore } from './stores/IdempotencyStore';
import { LockStore } from './stores/LockStore';
import { TripDistanceStore } from './stores/TripDistanceStore';
export class RedisService {
  public readonly provider: RedisProvider;
  public readonly otp: OtpStore;
  public readonly epoch: EpochStore;
  public readonly sidBlacklist: SidBlacklistStore;
  public readonly rateLimit: RateLimitStore;
  public readonly idempotency: IdempotencyStore;
  public readonly lock: LockStore;
  public readonly tripDistance: TripDistanceStore;
  constructor(
    redisProvider: RedisProvider,
    otpStore: OtpStore,
    epochStore: EpochStore,
    sidBlacklistStore: SidBlacklistStore,
    rateLimitStore: RateLimitStore,
    idempotencyStore: IdempotencyStore,
    lockStore: LockStore,
    tripDistanceStore: TripDistanceStore,
  ) {
    this.provider = redisProvider;
    this.otp = otpStore;
    this.epoch = epochStore;
    this.sidBlacklist = sidBlacklistStore;
    this.rateLimit = rateLimitStore;
    this.idempotency = idempotencyStore;
    this.lock = lockStore;
    this.tripDistance = tripDistanceStore;
  }
}
