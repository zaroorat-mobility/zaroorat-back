import { DatabaseService } from '@core/database';

export interface CityDto {
  id: string;
  code: string;
  name: string;
  state: string | null;
  isActive: boolean;
}

export class AdminCityService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listActive(): Promise<{ data: CityDto[] }> {
    const rows = await this.databaseService.client.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    // Fallback when cities table is empty (pre-seed): pricing/surge codes used in ops
    if (rows.length === 0) {
      return {
        data: [
          {
            id: 'GLOBAL',
            code: 'GLOBAL',
            name: 'All cities (global)',
            state: null,
            isActive: true,
          },
          { id: 'SGR', code: 'SGR', name: 'Srinagar', state: 'Jammu & Kashmir', isActive: true },
        ],
      };
    }

    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        state: r.state,
        isActive: r.isActive,
      })),
    };
  }
}
