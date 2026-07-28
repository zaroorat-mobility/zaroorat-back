import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/** Outcome of a fixed-window rate-limit check. */
export interface RateLimitResult {
  /** Whether this hit is within the limit. */
  allowed: boolean;
  /** Hits recorded in the current window (including this one). */
  current: number;
  /** Remaining hits before the limit is hit (never negative). */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters and minimum-interval guards backing the OTP/abuse rate
 * limits (auth doc 02 §4.2). The store owns the counting mechanic only — the
 * scope name, limit, and window are supplied by the caller (the strictest of the
 * per-phone / per-device / per-IP axes is composed in the service layer).
 */
export class RateLimitStore {
  private readonly client: Redis;

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Record a hit against a fixed window and report whether it is within limit.
   * @param scope Rate-limit scope (e.g. `otp:req`, `otp:dev`, `otp:ip`).
   * @param id Identifier within the scope (phone/device/ip).
   * @param limit Maximum hits allowed in the window.
   * @param windowSeconds Window length in seconds.
   * @returns The limit decision plus counters for `Retry-After`.
   */
  async hit(
    scope: string,
    id: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const key = RedisKeys.rateLimit(scope, id);
    const current = await this.client.incr(key);
    if (current === 1) await this.client.expire(key, windowSeconds);

    const ttl = await this.client.ttl(key);
    return {
      allowed: current <= limit,
      current,
      remaining: Math.max(0, limit - current),
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  /**
   * Enforce a minimum interval between actions (e.g. OTP resend ≥ 60 s). Uses
   * `SET NX EX` as a short-lived gate.
   * @param scope Gate scope.
   * @param id Identifier within the scope.
   * @param intervalSeconds Minimum seconds between allowed actions.
   * @returns `allowed: true` when no recent action exists, else the remaining wait.
   */
  async enforceMinInterval(
    scope: string,
    id: string,
    intervalSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const key = RedisKeys.rateLimit(`${scope}:gap`, id);
    const set = await this.client.set(key, '1', 'EX', intervalSeconds, 'NX');
    if (set === 'OK') return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await this.client.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : intervalSeconds };
  }
}
