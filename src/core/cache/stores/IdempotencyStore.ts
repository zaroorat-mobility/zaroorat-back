import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/**
 * Stored-response idempotency (auth doc 04 §5, NFR-RESIL-02).
 *
 * A keyed mutation (verify / refresh) stores its success response here; a retry
 * with the same `Idempotency-Key` replays the stored value instead of executing
 * again. This store handles serialization and the claim/read/write mechanics; the
 * decision of what constitutes a replay-vs-execute is a service concern. The
 * database unique constraints remain the ultimate safety net (doc 06 §Consistency).
 */
export class IdempotencyStore {
  private readonly client: Redis;

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Read a previously stored response for a key.
   * @typeParam T Shape of the stored value.
   * @param key Client idempotency key.
   * @returns The parsed value, or `null` if nothing is stored.
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(RedisKeys.idempotency(key));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /**
   * Store (overwrite) a response for a key with a TTL.
   * @param key Client idempotency key.
   * @param value JSON-serialisable response to store.
   * @param ttlSeconds Retention window (~24 h for auth flows).
   */
  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.idempotency(key), JSON.stringify(value), 'EX', ttlSeconds);
  }

  /**
   * Atomically claim a key by storing a value only if absent.
   * @param key Client idempotency key.
   * @param value JSON-serialisable value to store on claim.
   * @param ttlSeconds Retention window.
   * @returns `true` if this call claimed the key; `false` if it already existed.
   */
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
}
