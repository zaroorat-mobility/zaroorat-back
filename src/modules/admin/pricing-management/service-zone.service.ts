import type { RideServiceType } from '../../../generated/prisma/index.js';
import { FareRuleConflictError } from './pricing.errors.js';
import type { AdminGeographicService } from '../geographic-management/admin-geographic.service.js';

export interface ServiceZoneDto {
  id: string;
  code: string;
  name: string;
  zoneType: string;
  cityCode: string;
  isActive: boolean;
}

export class AdminServiceZoneService {
  constructor(private readonly adminGeographicService: AdminGeographicService) {}

  async listByCityCode(cityCode: string): Promise<ServiceZoneDto[]> {
    return this.adminGeographicService.listActiveServiceZonesByCity(cityCode);
  }

  async assertZoneBelongsToCity(serviceZoneId: string, cityCode: string): Promise<void> {
    try {
      await this.adminGeographicService.assertZoneBelongsToCity(serviceZoneId, cityCode);
    } catch {
      throw new FareRuleConflictError(`Service zone does not belong to city ${cityCode}`);
    }
  }
}

export function parseServiceType(raw?: string | null): RideServiceType | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const key = raw.toUpperCase();
  if (key === 'INSTANT' || key === 'SCHEDULED' || key === 'RENTAL' || key === 'OUTSTATION') {
    return key as RideServiceType;
  }
  return null;
}

export function serviceTypeUi(value: RideServiceType | null | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase();
}
