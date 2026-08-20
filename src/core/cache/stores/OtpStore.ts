import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';
export interface OtpChallengeMeta {
  challengeId: string;
  otpExpiresAt: number;
}
export interface ActiveOtpChallenge extends OtpChallengeMeta {
  resendTtlSeconds: number;
}
export type ClaimChallengeResult =
  | {
      status: 'active';
      challenge: ActiveOtpChallenge;
    }
  | {
      status: 'rate_limited';
      retryAfterSeconds: number;
    }
  | {
      status: 'claimed';
      payload: string;
    };
export class OtpStore {
  private readonly client: Redis;
  private static readonly CONSUME_LUA =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  private static readonly INCREMENT_ATTEMPTS_LUA = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count`;
  private static readonly CLAIM_CHALLENGE_LUA = `
    local existing = redis.call('GET', KEYS[1])
    if existing then
      return {0, existing, redis.call('TTL', KEYS[1])}
    end

    local count = redis.call('INCR', KEYS[2])
    if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
    if count > tonumber(ARGV[3]) then
      local ttl = redis.call('TTL', KEYS[2])
      if ttl < 0 then ttl = tonumber(ARGV[4]) end
      return {1, '', ttl}
    end

    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    return {2, ARGV[1], tonumber(ARGV[2])}`;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }
  async store(purpose: string, phone: string, hash: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otp(purpose, phone), hash, 'EX', ttlSeconds);
  }
  async clearSecret(purpose: string, phone: string): Promise<void> {
    await this.client.del(RedisKeys.otp(purpose, phone));
  }
  async consume(purpose: string, phone: string, presentedHash: string): Promise<boolean> {
    const deleted = (await this.client.eval(
      OtpStore.CONSUME_LUA,
      1,
      RedisKeys.otp(purpose, phone),
      presentedHash,
    )) as number;
    return deleted === 1;
  }
  async claimChallenge(
    purpose: string,
    phone: string,
    meta: OtpChallengeMeta,
    options: {
      cooldownSeconds: number;
      rateLimitScope: string;
      limit: number;
      windowSeconds: number;
    },
  ): Promise<ClaimChallengeResult> {
    const payload = JSON.stringify(meta);
    const [status, value, ttl] = (await this.client.eval(
      OtpStore.CLAIM_CHALLENGE_LUA,
      2,
      RedisKeys.otpChallenge(purpose, phone),
      RedisKeys.rateLimit(options.rateLimitScope, phone),
      payload,
      String(options.cooldownSeconds),
      String(options.limit),
      String(options.windowSeconds),
    )) as [number, string, number];
    if (status === 0) {
      const active = JSON.parse(value) as OtpChallengeMeta;
      return { status: 'active', challenge: { ...active, resendTtlSeconds: ttl > 0 ? ttl : 0 } };
    }
    if (status === 1) {
      return { status: 'rate_limited', retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds };
    }
    return { status: 'claimed', payload };
  }
  async releaseChallenge(purpose: string, phone: string, payload: string): Promise<boolean> {
    const deleted = (await this.client.eval(
      OtpStore.CONSUME_LUA,
      1,
      RedisKeys.otpChallenge(purpose, phone),
      payload,
    )) as number;
    return deleted === 1;
  }
  async incrementAttempts(purpose: string, phone: string, ttlSeconds: number): Promise<number> {
    return (await this.client.eval(
      OtpStore.INCREMENT_ATTEMPTS_LUA,
      1,
      RedisKeys.otpAttempts(purpose, phone),
      String(ttlSeconds),
    )) as number;
  }
  async getAttempts(purpose: string, phone: string): Promise<number> {
    const value = await this.client.get(RedisKeys.otpAttempts(purpose, phone));
    return value ? Number.parseInt(value, 10) : 0;
  }
  async clearAttempts(purpose: string, phone: string): Promise<void> {
    await this.client.del(RedisKeys.otpAttempts(purpose, phone));
  }
  async setChallenge(
    purpose: string,
    phone: string,
    meta: OtpChallengeMeta,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(
      RedisKeys.otpChallenge(purpose, phone),
      JSON.stringify(meta),
      'EX',
      ttlSeconds,
    );
  }
  async getChallenge(purpose: string, phone: string): Promise<ActiveOtpChallenge | null> {
    const key = RedisKeys.otpChallenge(purpose, phone);
    const raw = await this.client.get(key);
    if (!raw) return null;
    const ttl = await this.client.ttl(key);
    const meta = JSON.parse(raw) as OtpChallengeMeta;
    return { ...meta, resendTtlSeconds: ttl > 0 ? ttl : 0 };
  }
  async clearChallenge(purpose: string, phone: string): Promise<void> {
    await this.client.del(RedisKeys.otpChallenge(purpose, phone));
  }
  async lock(purpose: string, phone: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otpLock(purpose, phone), '1', 'EX', ttlSeconds);
  }
  async isLocked(purpose: string, phone: string): Promise<boolean> {
    return (await this.client.exists(RedisKeys.otpLock(purpose, phone))) === 1;
  }
}
