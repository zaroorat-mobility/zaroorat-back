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

export class OtpStore {
  private readonly client: Redis;

  private static readonly CONSUME_LUA =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

  private static readonly INCREMENT_ATTEMPTS_LUA = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return count`;

  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  async store(purpose: string, phone: string, hash: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otp(purpose, phone), hash, 'EX', ttlSeconds);
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

  async incrementAttempts(phone: string, ttlSeconds: number): Promise<number> {
    return (await this.client.eval(
      OtpStore.INCREMENT_ATTEMPTS_LUA,
      1,
      RedisKeys.otpAttempts(phone),
      String(ttlSeconds),
    )) as number;
  }

  async getAttempts(phone: string): Promise<number> {
    const value = await this.client.get(RedisKeys.otpAttempts(phone));
    return value ? Number.parseInt(value, 10) : 0;
  }

  async clearAttempts(phone: string): Promise<void> {
    await this.client.del(RedisKeys.otpAttempts(phone));
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

  async lock(phone: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.otpLock(phone), '1', 'EX', ttlSeconds);
  }

  async isLocked(phone: string): Promise<boolean> {
    return (await this.client.exists(RedisKeys.otpLock(phone))) === 1;
  }
}
