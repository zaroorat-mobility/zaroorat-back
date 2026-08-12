import { BaseRepository, DatabaseService } from '@core/database';

export class DriverAccessRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async isOperableDriver(userId: string): Promise<boolean> {
    const driver = await this.client.driver.findFirst({
      where: { userId, verificationStatus: 'VERIFIED', isSuspended: false, deletedAt: null },
      select: { id: true },
    });
    return driver !== null;
  }
}
