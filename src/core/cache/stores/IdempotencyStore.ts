import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys, type IdempotencyOperation } from '../keys';
export class IdempotencyStore {
  private readonly client: Redis;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }
  async get<T>(operation: IdempotencyOperation, key: string): Promise<T | null> {
    const raw = await this.client.get(RedisKeys.idempotency(operation, key));
    return raw ? (JSON.parse(raw) as T) : null;
  }
  async put(
    operation: IdempotencyOperation,
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(
      RedisKeys.idempotency(operation, key),
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }
  async putIfAbsent(
    operation: IdempotencyOperation,
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    const set = await this.client.set(
      RedisKeys.idempotency(operation, key),
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
    return set === 'OK';
  }
  async forget(operation: IdempotencyOperation, key: string): Promise<void> {
    await this.client.del(RedisKeys.idempotency(operation, key));
  }
  async runOnce<T>(
    operation: IdempotencyOperation,
    key: string,
    ttlSeconds: number,
    action: () => Promise<T>,
  ): Promise<T> {
    const claimed = await this.putIfAbsent(operation, key, { state: 'in_flight' }, ttlSeconds);
    if (!claimed) {
      const record = await this.get<IdempotencyRecord<T>>(operation, key);
      if (record?.state === 'done') return record.result;
      throw new IdempotencyInFlightError();
    }
    try {
      const result = await action();
      await this.put(
        operation,
        key,
        { state: 'done', result } satisfies IdempotencyRecord<T>,
        ttlSeconds,
      );
      return result;
    } catch (err) {
      await this.forget(operation, key);
      throw err;
    }
  }
}
export type IdempotencyRecord<T> =
  | {
      state: 'in_flight';
    }
  | {
      state: 'done';
      result: T;
    };
export class IdempotencyInFlightError extends Error {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';
  constructor(message = 'A request with this Idempotency-Key is already in progress') {
    super(message);
    this.name = 'IdempotencyInFlightError';
  }
}
