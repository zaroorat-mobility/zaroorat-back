import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';
export class LockStore {
  private readonly client: Redis;
  private static readonly RELEASE_LUA =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }
  async acquire(resource: string, ttlMilliseconds: number): Promise<string | null> {
    const token = randomUUID();
    const set = await this.client.set(RedisKeys.lock(resource), token, 'PX', ttlMilliseconds, 'NX');
    return set === 'OK' ? token : null;
  }
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
