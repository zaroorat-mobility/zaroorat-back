import { BaseRepository, DatabaseService } from '@core/database';

/**
 * Read-only access to driver operability for the authorization guard.
 *
 * AUTH *consumes* driver state, it never owns it (auth doc 01 §3.2): a driver is
 * operable when `verification_status = VERIFIED`, not suspended, and not deleted.
 * This thin read lets the `authorize` hook enforce the ride-accept conjunction
 * (R-AUTH-23) live. When the driver module is built it may take ownership of this
 * read; the authorize hook depends only on the `isOperableDriver` shape.
 */
export class DriverAccessRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Report whether a user is an operable driver (verified, not suspended).
   * @param userId The authenticated user's UUID.
   * @returns `true` if an operable driver record exists for the user.
   */
  async isOperableDriver(userId: string): Promise<boolean> {
    const driver = await this.client.driver.findFirst({
      where: { userId, verificationStatus: 'VERIFIED', isSuspended: false, deletedAt: null },
      select: { id: true },
    });
    return driver !== null;
  }
}
