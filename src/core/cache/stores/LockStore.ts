import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/**
 * Single-holder distributed locks (`SET NX PX` + fenced release).
 *
 * Guarantees at most one holder of a named resource, auto-expiring so a crashed
 * holder's lock frees itself (doc 06 §`ride:matchlock`). Release is fenced by a
 * per-acquisition token compared in a Lua script, so a caller can never release a
 * lock it no longer owns (e.g. after its TTL lapsed and another holder acquired).
 */
export class LockStore {
  private readonly client: Redis;

  /** Delete the key only if its value still matches the caller's token. */
  private static readonly RELEASE_LUA =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Attempt to acquire a lock over a resource.
   * @param resource Logical resource name (e.g. `otp:consume:{phone}`).
   * @param ttlMilliseconds Lock lifetime; the lock auto-releases after this.
   * @returns A fencing token to pass to {@link release}, or `null` if the lock is held.
   */
  async acquire(resource: string, ttlMilliseconds: number): Promise<string | null> {
    const token = randomUUID();
    const set = await this.client.set(RedisKeys.lock(resource), token, 'PX', ttlMilliseconds, 'NX');
    return set === 'OK' ? token : null;
  }

  /**
   * Release a lock, but only if the caller still owns it (token match).
   * @param resource Logical resource name.
   * @param token The fencing token returned by {@link acquire}.
   * @returns `true` if this call released the lock; `false` if it no longer owned it.
   */
  async release(resource: string, token: string): Promise<boolean> {
    const released = (await this.client.eval(
      LockStore.RELEASE_LUA,
      1,
      RedisKeys.lock(resource),
      token,
    )) as number;
    return released === 1;
  }
}
