import type { Redis } from 'ioredis';
import { RedisProvider } from '../RedisProvider';
import { RedisKeys } from '../keys';

/**
 * Per-session revocation denylist (auth doc 02 §3.3).
 *
 * Single-session logout and cap-eviction revoke one `sid` without bumping the
 * whole user epoch (which would sign out every device). Each revoked `sid` is
 * stored as its own short-TTL key so the denylist self-cleans once the token it
 * blocks would have expired anyway — implemented as per-key TTL + EXISTS rather
 * than an ever-growing SET, honouring the spec's "short-TTL denylist" intent.
 */
export class SidBlacklistStore {
  private readonly client: Redis;

  /** @param redisProvider Owner of the shared ioredis client. */
  constructor(redisProvider: RedisProvider) {
    this.client = redisProvider.client;
  }

  /**
   * Mark a session id revoked for a bounded window.
   * @param sid Session id (`sid`) to deny.
   * @param ttlSeconds How long to keep the marker — set to the revoked token's
   *        remaining lifetime so it expires naturally.
   */
  async revoke(sid: string, ttlSeconds: number): Promise<void> {
    await this.client.set(RedisKeys.sidRevoked(sid), '1', 'EX', ttlSeconds);
  }

  /**
   * Report whether a session id has been revoked.
   * @param sid Session id (`sid`).
   * @returns `true` if the sid is on the denylist.
   */
  async isRevoked(sid: string): Promise<boolean> {
    return (await this.client.exists(RedisKeys.sidRevoked(sid))) === 1;
  }
}
