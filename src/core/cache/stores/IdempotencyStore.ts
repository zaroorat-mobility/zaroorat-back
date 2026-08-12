import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

export class IdempotencyStore {
  private readonly client: Redis;

  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(RedisKeys.idempotency(key));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.idempotency(key), JSON.stringify(value), 'EX', ttlSeconds);
  }

  async putIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const set = await this.client.set(
      RedisKeys.idempotency(key),
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
    return set === 'OK';
  }

  async forget(key: string): Promise<void> {
    await this.client.del(RedisKeys.idempotency(key));
  }

  async runOnce<T>(key: string, ttlSeconds: number, operation: () => Promise<T>): Promise<T> {
    const claimed = await this.putIfAbsent(key, { state: 'in_flight' }, ttlSeconds);

    if (!claimed) {
      const record = await this.get<IdempotencyRecord<T>>(key);
      if (record?.state === 'done') return record.result;
      throw new IdempotencyInFlightError();
    }

    try {
      const result = await operation();
      await this.put(key, { state: 'done', result } satisfies IdempotencyRecord<T>, ttlSeconds);
      return result;
    } catch (err) {
      await this.forget(key);
      throw err;
    }
  }
}

export type IdempotencyRecord<T> = { state: 'in_flight' } | { state: 'done'; result: T };

export class IdempotencyInFlightError extends Error {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  constructor(message = 'A request with this Idempotency-Key is already in progress') {
    super(message);
    this.name = 'IdempotencyInFlightError';
  }
}
