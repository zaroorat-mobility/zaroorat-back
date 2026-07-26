import { ProviderClient } from '../client/PrismaClientProvider';
import { DatabaseService } from '../DatabaseService';

/**
 * Abstract base for all domain repositories.
 *
 * Extend this to get type-safe, pool-aware database access
 * without any knowledge of Prisma internals, connection lifecycle,
 * or transaction management.
 */
export abstract class BaseRepository {
  constructor(protected readonly databaseService: DatabaseService) {}

  /** The singleton Prisma client used for queries. */
  protected get client(): ProviderClient {
    return this.databaseService.client;
  }
}
