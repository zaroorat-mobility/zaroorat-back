import { createHash } from 'node:crypto';
import { RedisService } from '@core/cache/RedisService.js';
import { DuplicateIdempotencyKeyError } from '../errors/payment.errors.js';

export interface IdempotencyEntry<T = unknown> {
  payloadHash: string;
  response: T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const child = (value as Record<string, unknown>)[key];

      return child === undefined ? null : `${JSON.stringify(key)}:${stableStringify(child)}`;
    })
    .filter((entry): entry is string => entry !== null);

  return `{${entries.join(',')}}`;
}

export class IdempotencyRepository {
  constructor(private readonly redis: RedisService) {}

  private buildScopedKey(userId: string, route: string, idempotencyKey: string): string {
    return `payment:idempotency:${userId}:${route}:${idempotencyKey}`;
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256')
      .update(stableStringify(payload ?? {}))
      .digest('hex');
  }

  async runIdempotent<T>(
    userId: string,
    route: string,
    key: string,
    payload: unknown,
    ttlSeconds: number,
    operation: () => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const scopedKey = this.buildScopedKey(userId, route, key);
    const currentHash = this.hashPayload(payload);

    const stored = await this.redis.idempotency.get<StoredRecord<T>>(scopedKey);
    const existing = unwrap<T>(stored);
    if (existing) {
      if (existing.payloadHash !== currentHash) {
        throw new DuplicateIdempotencyKeyError();
      }
      return { result: existing.response, replayed: true };
    }

    const claimed = await this.redis.idempotency.runOnce<IdempotencyEntry<T>>(
      scopedKey,
      ttlSeconds,
      async () => ({ payloadHash: currentHash, response: await operation() }),
    );

    if (claimed.payloadHash !== currentHash) {
      throw new DuplicateIdempotencyKeyError();
    }

    return { result: claimed.response, replayed: false };
  }
}

type StoredRecord<T> =
  { state: 'in_flight' } | { state: 'done'; result: IdempotencyEntry<T> } | IdempotencyEntry<T>;

function unwrap<T>(stored: StoredRecord<T> | null): IdempotencyEntry<T> | null {
  if (!stored) return null;
  if ('state' in stored) {
    return stored.state === 'done' ? stored.result : null;
  }
  return stored;
}
