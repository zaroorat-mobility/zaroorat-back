import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';
export interface RateLimitResult {
  allowed: boolean;
  current: number;
  remaining: number;
  retryAfterSeconds: number;
}
export class RateLimitStore {
  private readonly client: Redis;
  private static readonly HIT_LUA = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return {count, redis.call('TTL', KEYS[1])}`;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }
  async hit(
    scope: string,
    id: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const key = RedisKeys.rateLimit(scope, id);
    const [current, ttl] = (await this.client.eval(
      RateLimitStore.HIT_LUA,
      1,
      key,
      String(windowSeconds),
    )) as [number, number];
    return {
      allowed: current <= limit,
      current,
      remaining: Math.max(0, limit - current),
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }
  /// `hit` without the hit: reads a counter's current standing and spends
  /// nothing.
  ///
  /// Exists because some budgets are spent on *failures* but must be checked
  /// before every attempt. Using `hit` for that check would make an honest
  /// caller's successful attempts consume the same budget as an attacker's
  /// failures — a busy driver would lock themselves out doing their job.
  ///
  /// A missing key reads as zero, which is `allowed`. That is the same
  /// fail-forward `hit` has on a fresh window, and it is safe here for the same
  /// reason: the caller still records the failure afterwards, so a race between
  /// two peeks costs at most one extra attempt before the counter catches up.
  async peek(scope: string, id: string, limit: number): Promise<RateLimitResult> {
    const key = RedisKeys.rateLimit(scope, id);
    const [raw, ttl] = await Promise.all([this.client.get(key), this.client.ttl(key)]);
    const current = raw === null ? 0 : Number(raw);
    const counted = Number.isFinite(current) && current > 0 ? current : 0;
    return {
      allowed: counted < limit,
      current: counted,
      remaining: Math.max(0, limit - counted),
      retryAfterSeconds: ttl > 0 ? ttl : 0,
    };
  }
  /// Forget a counter outright. For budgets that are spent on failures and
  /// forgiven on success, where letting the window simply expire would keep
  /// punishing a caller who has already proved themselves.
  async reset(scope: string, id: string): Promise<void> {
    await this.client.del(RedisKeys.rateLimit(scope, id));
  }
  async enforceMinInterval(
    scope: string,
    id: string,
    intervalSeconds: number,
  ): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }> {
    const key = RedisKeys.rateLimit(`${scope}:gap`, id);
    const set = await this.client.set(key, '1', 'EX', intervalSeconds, 'NX');
    if (set === 'OK') return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await this.client.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : intervalSeconds };
  }
}
