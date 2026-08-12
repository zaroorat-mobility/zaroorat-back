import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

export class EpochStore {
  private readonly client: Redis;

  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  async get(userId: string): Promise<number> {
    const value = await this.client.get(RedisKeys.epoch(userId));
    return value ? Number.parseInt(value, 10) : 0;
  }

  async bump(userId: string): Promise<number> {
    return this.client.incr(RedisKeys.epoch(userId));
  }
}
