import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

export class SidBlacklistStore {
  private readonly client: Redis;

  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  async revoke(sid: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.sidRevoked(sid), '1', 'EX', ttlSeconds);
  }

  async isRevoked(sid: string): Promise<boolean> {
    return (await this.client.exists(RedisKeys.sidRevoked(sid))) === 1;
  }
}
