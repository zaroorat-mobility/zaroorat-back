import { ProviderClient } from '../client/PrismaClientProvider';
import { DatabaseService } from '../DatabaseService';
export abstract class BaseRepository {
  constructor(protected readonly databaseService: DatabaseService) {}
  protected get client(): ProviderClient {
    return this.databaseService.client;
  }
}
