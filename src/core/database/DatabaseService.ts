import { ProviderClient, PrismaClientProvider } from './client/PrismaClientProvider';
import { TransactionManager } from './TransactionManager';

/**
 * Application-facing facade for data access.
 *
 * Exposes the Prisma client and TransactionManager to the Repository layer.
 * Connection lifecycle, health, verification, retry, error mapping, and metrics
 * are owned by their respective infrastructure classes.
 */
export class DatabaseService {
  constructor(
    private readonly provider: PrismaClientProvider,
    public readonly transactionManager: TransactionManager,
  ) {}

  /** The singleton Prisma client — the only way for Repositories to reach the database. */
  public get client(): ProviderClient {
    return this.provider.client;
  }
}
