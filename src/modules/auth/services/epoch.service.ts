import { RedisService } from '@core/cache';

/**
 * Domain seam over the Redis session-epoch store (auth doc 02 §3.3).
 *
 * The epoch is the fast-revocation authority: every access token carries the
 * epoch at mint time, and the auth hook rejects a token whose epoch is stale.
 * Bumping it invalidates every outstanding access token for a user at once — the
 * response to suspension, role change, and refresh-token reuse. Services depend
 * on this seam rather than the Redis store directly.
 */
export class EpochService {
  /** @param redisService Facade exposing the epoch store. */
  constructor(private readonly redisService: RedisService) {}

  /**
   * Current epoch for a user (0 when none is stored).
   * @param userId User UUID.
   * @returns The current epoch value.
   */
  async current(userId: string): Promise<number> {
    return this.redisService.epoch.get(userId);
  }

  /**
   * Bump a user's epoch, invalidating all their outstanding access tokens.
   * @param userId User UUID.
   * @returns The new epoch value.
   */
  async bump(userId: string): Promise<number> {
    return this.redisService.epoch.bump(userId);
  }
}
