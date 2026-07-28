import { asClass, AwilixContainer } from 'awilix';

import { RedisProvider } from './RedisProvider';
import { OtpStore } from './stores/OtpStore';
import { EpochStore } from './stores/EpochStore';
import { SidBlacklistStore } from './stores/SidBlacklistStore';
import { RateLimitStore } from './stores/RateLimitStore';
import { IdempotencyStore } from './stores/IdempotencyStore';
import { LockStore } from './stores/LockStore';
import { RedisService } from './RedisService';

/**
 * Registers the Redis infrastructure into the Awilix container.
 *
 * Names are significant: CLASSIC injection resolves constructor params by name,
 * so `redisProvider`, `otpStore`, … must match the parameter names in the stores
 * and {@link RedisService}. `redisProvider` is deliberately distinct from the
 * database `provider` registration to avoid a name collision.
 *
 * @param container The application DI container.
 */
export function registerRedisModule(container: AwilixContainer): void {
  container.register({
    redisProvider: asClass(RedisProvider).singleton(),

    otpStore: asClass(OtpStore).singleton(),
    epochStore: asClass(EpochStore).singleton(),
    sidBlacklistStore: asClass(SidBlacklistStore).singleton(),
    rateLimitStore: asClass(RateLimitStore).singleton(),
    idempotencyStore: asClass(IdempotencyStore).singleton(),
    lockStore: asClass(LockStore).singleton(),

    redisService: asClass(RedisService).singleton(),
  });
}
