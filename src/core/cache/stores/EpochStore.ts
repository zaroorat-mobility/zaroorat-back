import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/// The epoch must outlive every token that carries it, so this tracks the
/// refresh-token lifetime (JWT_REFRESH_TTL_SECONDS, 30 days by default).
///
/// Read directly rather than through `@config` to keep the cache layer free of
/// a dependency on the auth configuration.
const EPOCH_TTL_SECONDS = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 2592000);

export class EpochStore {
  private readonly client: Redis;
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /// Renews the TTL on read, so a user who stays active keeps their epoch and
  /// only genuinely dormant ones are reaped — by which point their refresh token
  /// has expired anyway and an epoch of 0 is the correct answer.
  ///
  /// A bare INCR with no expiry left one permanent key per user that was never
  /// reclaimed (~90,000 at the target scale). GET and EXPIRE ship as a single
  /// round trip; EXPIRE on a missing key is a no-op.
  async get(userId: string): Promise<number> {
    const key = RedisKeys.epoch(userId);
    const results = await this.client.pipeline().get(key).expire(key, EPOCH_TTL_SECONDS).exec();
    // A pipeline reports a command-level failure in its result tuple instead of
    // rejecting. Rethrowing keeps the contract the plain GET had: an epoch store
    // that cannot be read answers 503, never a silent 0 that would decide
    // whether a token is still valid.
    const [readError, value] = results?.[0] ?? [];
    if (readError) throw readError;
    return value ? Number.parseInt(value as string, 10) : 0;
  }

  async bump(userId: string): Promise<number> {
    const key = RedisKeys.epoch(userId);
    const results = await this.client.pipeline().incr(key).expire(key, EPOCH_TTL_SECONDS).exec();
    // A bump that silently failed would leave revoked sessions live, so the
    // same rethrow applies here.
    const [bumpError, value] = results?.[0] ?? [];
    if (bumpError) throw bumpError;
    return (value as number | undefined) ?? 0;
  }
}
