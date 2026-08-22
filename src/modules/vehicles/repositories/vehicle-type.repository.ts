import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { VehicleType } from '../types/index.js';

export interface FindActiveTypesOptions {
  /// Reserved for the city/service-zone scoping the schema already models via
  /// `ServiceZone` but nothing yet writes. Accepting it here means callers do
  /// not change shape when that lands; today it is intentionally ignored.
  cityId?: string;
}

/// The single Prisma entry point for `VehicleType`. No other module queries the
/// table directly — rides and drivers both go through `VehicleTypeService`.
export class VehicleTypeRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActive(
    _options: FindActiveTypesOptions = {},
    tx?: TransactionClient,
  ): Promise<VehicleType[]> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async findById(id: string, tx?: TransactionClient): Promise<VehicleType | null> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findUnique({ where: { id } });
  }

  async findByCode(code: string, tx?: TransactionClient): Promise<VehicleType | null> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findUnique({ where: { code } });
  }

  /// One query for many ids — the multi-category quote resolves every option's
  /// type in a single round trip rather than one per option.
  async findManyByIds(ids: readonly string[], tx?: TransactionClient): Promise<VehicleType[]> {
    if (ids.length === 0) return [];
    const client = tx ?? this.db.client;
    return client.vehicleType.findMany({ where: { id: { in: [...ids] } } });
  }
}
