import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/**
 * Per-user session epoch — the fast-revocation authority (auth doc 02 §3.3).
 *
 * Every access token carries the epoch at mint time; the auth hook rejects a
 * token whose epoch differs from the current value. Bumping the epoch therefore
 * invalidates every outstanding access token for a user in one O(1) write. An
 * absent key means epoch 0 (the safe default): if Redis is flushed, all live
 * tokens carrying a non-zero epoch fail closed and clients re-authenticate.
 */
export class EpochStore {
  private readonly client: Redis;

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Read a user's current epoch.
   * @param userId User UUID.
   * @returns The epoch (0 if none is stored).
   */
  async get(userId: string): Promise<number> {
    const value = await this.client.get(RedisKeys.epoch(userId));
    return value ? Number.parseInt(value, 10) : 0;
  }

  /**
   * Bump a user's epoch, invalidating all outstanding access tokens.
   * @param userId User UUID.
   * @returns The new epoch value.
   */
  async bump(userId: string): Promise<number> {
    return this.client.incr(RedisKeys.epoch(userId));
  }
}
