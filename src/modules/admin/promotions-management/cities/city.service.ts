import { DatabaseService } from '@core/database';
import type { AdminGeographicService } from '../../geographic-management/admin-geographic.service.js';

export interface CityDto {
  id: string;
  code: string;
  name: string;
  state: string | null;
  isActive: boolean;
}

export class AdminCityService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminGeographicService: AdminGeographicService,
  ) {}

  async listActive(): Promise<{ data: CityDto[] }> {
    const data = await this.adminGeographicService.listActiveCityCatalog();
    return { data };
  }
}
