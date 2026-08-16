import { ProviderClient, PrismaClientProvider } from './client/PrismaClientProvider';
import { TransactionManager } from './TransactionManager';
export class DatabaseService {
  constructor(
    private readonly provider: PrismaClientProvider,
    public readonly transactionManager: TransactionManager,
  ) {}
  public get client(): ProviderClient {
    return this.provider.client;
  }
}
