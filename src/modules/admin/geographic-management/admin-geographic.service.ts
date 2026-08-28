import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import type { ServiceZoneType } from '../../../generated/prisma/index.js';
import {
  assertValidPolygon,
  assertZoneWithinCity,
  pointGeoJson,
  polygonGeoJson,
} from '../../geographic/utils/postgis.js';
import type {
  CreateCityBody,
  CreateServiceZoneBody,
  CreateStateBody,
  UpdateCityBody,
  UpdateServiceZoneBody,
  UpdateStateBody,
} from './geo.schemas.js';
import {
  CityNotFoundError,
  GeographicConflictError,
  GeographicValidationError,
  ServiceZoneNotFoundError,
  StateNotFoundError,
} from './geographic.errors.js';

export interface CountryDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface StateDto {
  id: string;
  countryCode: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface CityListDto {
  id: string;
  code: string;
  name: string;
  state: string | null;
  stateId: string | null;
  country: string;
  isActive: boolean;
  hasBoundary: boolean;
  zoneCount: number;
}

export interface CityDetailDto extends CityListDto {
  timezone: string;
  currency: string;
  launchedAt: string | null;
  center: { lng: number; lat: number } | null;
  boundary: number[][][] | null;
}

export interface ServiceZoneListDto {
  id: string;
  code: string;
  name: string;
  zoneType: ServiceZoneType;
  cityCode: string;
  cityId: string;
  isActive: boolean;
  allowsPickup: boolean;
  allowsDropoff: boolean;
  fareRuleCount: number;
}

export interface ServiceZoneDetailDto extends ServiceZoneListDto {
  boundary: number[][][];
  vehicleTypeIds: string[];
  vehicleTypeCodes: string[];
}

export class AdminGeographicService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listCountries(): Promise<{ data: CountryDto[] }> {
    const rows = await this.databaseService.client.country.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        isActive: r.isActive,
      })),
    };
  }

  async listStates(options?: {
    countryCode?: string;
    activeOnly?: boolean;
  }): Promise<{ data: StateDto[] }> {
    const rows = await this.databaseService.client.state.findMany({
      where: {
        ...(options?.activeOnly ? { isActive: true } : {}),
        ...(options?.countryCode ? { country: { code: options.countryCode } } : {}),
      },
      include: { country: true },
      orderBy: { name: 'asc' },
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        countryCode: r.country.code,
        code: r.code,
        name: r.name,
        isActive: r.isActive,
      })),
    };
  }

  async createState(body: CreateStateBody): Promise<StateDto> {
    const country = await this.databaseService.client.country.findUnique({
      where: { code: body.countryCode },
    });
    if (!country) throw new GeographicValidationError(`Country ${body.countryCode} not found`);

    const created = await this.databaseService.client.state.create({
      data: {
        countryId: country.id,
        code: body.code.toUpperCase(),
        name: body.name,
        isActive: body.isActive ?? true,
      },
      include: { country: true },
    });
    return {
      id: created.id,
      countryCode: created.country.code,
      code: created.code,
      name: created.name,
      isActive: created.isActive,
    };
  }

  async updateState(id: string, body: UpdateStateBody): Promise<StateDto> {
    const existing = await this.databaseService.client.state.findUnique({
      where: { id },
      include: { country: true },
    });
    if (!existing) throw new StateNotFoundError();

    const updated = await this.databaseService.client.state.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include: { country: true },
    });
    return {
      id: updated.id,
      countryCode: updated.country.code,
      code: updated.code,
      name: updated.name,
      isActive: updated.isActive,
    };
  }

  async listCities(options: {
    countryCode?: string;
    stateId?: string;
    activeOnly?: boolean;
  }): Promise<{ data: CityListDto[] }> {
    const rows = await this.databaseService.client.city.findMany({
      where: {
        ...(options.activeOnly ? { isActive: true } : {}),
        ...(options.stateId ? { stateId: options.stateId } : {}),
        ...(options.countryCode ? { country: options.countryCode } : {}),
      },
      include: {
        stateRef: true,
        zones: { select: { id: true } },
      },
      orderBy: { name: 'asc' },
    });

    const boundaryFlags = await this.databaseService.client.$queryRaw<
      Array<{ id: string; has_boundary: boolean }>
    >`
      SELECT id, boundary IS NOT NULL AS has_boundary FROM cities
    `;
    const hasBoundaryById = new Map(boundaryFlags.map((r) => [r.id, r.has_boundary]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        state: r.stateRef?.name ?? r.state,
        stateId: r.stateId,
        country: r.country,
        isActive: r.isActive,
        hasBoundary: hasBoundaryById.get(r.id) ?? false,
        zoneCount: r.zones.length,
      })),
    };
  }

  /** Legacy promotions/fare list shape */
  async listActiveCityCatalog(): Promise<
    Array<{ id: string; code: string; name: string; state: string | null; isActive: boolean }>
  > {
    const { data } = await this.listCities({ activeOnly: true });
    if (data.length === 0) {
      return [
        { id: 'GLOBAL', code: 'GLOBAL', name: 'All cities (global)', state: null, isActive: true },
        { id: 'SGR', code: 'SGR', name: 'Srinagar', state: 'Jammu & Kashmir', isActive: true },
      ];
    }
    return data.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      state: c.state,
      isActive: c.isActive,
    }));
  }

  async getCityById(id: string): Promise<CityDetailDto> {
    const row = await this.databaseService.client.city.findUnique({
      where: { id },
      include: { stateRef: true, zones: { select: { id: true } } },
    });
    if (!row) throw new CityNotFoundError();

    const geo = await this.databaseService.client.$queryRaw<
      Array<{
        has_boundary: boolean;
        center_lng: number | null;
        center_lat: number | null;
        boundary: string | null;
      }>
    >`
      SELECT
        boundary IS NOT NULL AS has_boundary,
        ST_X(center::geometry) AS center_lng,
        ST_Y(center::geometry) AS center_lat,
        ST_AsGeoJSON(boundary::geometry) AS boundary
      FROM cities WHERE id = ${id}::uuid
    `;
    const g = geo[0];
    let boundary: number[][][] | null = null;
    if (g?.boundary) {
      const parsed = JSON.parse(g.boundary) as { coordinates: number[][][] };
      boundary = parsed.coordinates;
    }

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      state: row.stateRef?.name ?? row.state,
      stateId: row.stateId,
      country: row.country,
      isActive: row.isActive,
      hasBoundary: g?.has_boundary ?? false,
      zoneCount: row.zones.length,
      timezone: row.timezone,
      currency: row.currency,
      launchedAt: row.launchedAt?.toISOString().slice(0, 10) ?? null,
      center:
        g?.center_lng != null && g?.center_lat != null
          ? { lng: g.center_lng, lat: g.center_lat }
          : null,
      boundary,
    };
  }

  async createCity(body: CreateCityBody): Promise<CityDetailDto> {
    if (body.isActive && body.code !== 'GLOBAL' && !body.boundary) {
      throw new GeographicValidationError('Active cities require a boundary polygon');
    }
    if (body.boundary) {
      await assertValidPolygon(this.databaseService, body.boundary).catch(() => {
        throw new GeographicValidationError('Invalid city boundary polygon');
      });
    }

    const state = body.stateId
      ? await this.databaseService.client.state.findUnique({ where: { id: body.stateId } })
      : null;

    const created = await this.databaseService.client.city.create({
      data: {
        code: body.code.toUpperCase(),
        name: body.name,
        ...(body.stateId ? { stateId: body.stateId } : {}),
        state: state?.name ?? null,
        timezone: body.timezone ?? 'Asia/Kolkata',
        currency: body.currency ?? 'INR',
        isActive: body.isActive ?? true,
        ...(body.launchedAt ? { launchedAt: new Date(body.launchedAt) } : {}),
      },
    });

    if (body.center) {
      const centerJson = pointGeoJson(body.center.lng, body.center.lat);
      await this.databaseService.client.$executeRaw`
        UPDATE cities SET center = ST_GeomFromGeoJSON(${centerJson}) WHERE id = ${created.id}::uuid
      `;
    }
    if (body.boundary) {
      const boundaryJson = polygonGeoJson(body.boundary);
      await this.databaseService.client.$executeRaw`
        UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson}) WHERE id = ${created.id}::uuid
      `;
    }

    return this.getCityById(created.id);
  }

  async updateCity(id: string, body: UpdateCityBody): Promise<CityDetailDto> {
    const existing = await this.databaseService.client.city.findUnique({ where: { id } });
    if (!existing) throw new CityNotFoundError();

    const nextActive = body.isActive ?? existing.isActive;
    if (nextActive && existing.code !== 'GLOBAL' && body.boundary === null) {
      const geo = await this.databaseService.client.$queryRaw<Array<{ has_boundary: boolean }>>`
        SELECT boundary IS NOT NULL AS has_boundary FROM cities WHERE id = ${id}::uuid
      `;
      if (!geo[0]?.has_boundary && body.boundary === undefined) {
        throw new GeographicValidationError('Active cities require a boundary polygon');
      }
    }

    if (body.boundary) {
      await assertValidPolygon(this.databaseService, body.boundary).catch(() => {
        throw new GeographicValidationError('Invalid city boundary polygon');
      });
    }

    const state = body.stateId
      ? await this.databaseService.client.state.findUnique({ where: { id: body.stateId } })
      : null;

    await this.databaseService.client.city.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: body.code.toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.stateId !== undefined ? { stateId: body.stateId } : {}),
        ...(state ? { state: state.name } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.launchedAt !== undefined
          ? { launchedAt: body.launchedAt ? new Date(body.launchedAt) : null }
          : {}),
      },
    });

    if (body.center) {
      const centerJson = pointGeoJson(body.center.lng, body.center.lat);
      await this.databaseService.client.$executeRaw`
        UPDATE cities SET center = ST_GeomFromGeoJSON(${centerJson}) WHERE id = ${id}::uuid
      `;
    }
    if (body.boundary) {
      const boundaryJson = polygonGeoJson(body.boundary);
      await this.databaseService.client.$executeRaw`
        UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson}) WHERE id = ${id}::uuid
      `;
    }

    return this.getCityById(id);
  }

  async listServiceZones(options: {
    cityCode?: string;
    zoneType?: ServiceZoneType;
    activeOnly?: boolean;
  }): Promise<{ data: ServiceZoneListDto[] }> {
    const rows = await this.databaseService.client.serviceZone.findMany({
      where: {
        ...(options.activeOnly ? { isActive: true } : {}),
        ...(options.zoneType ? { zoneType: options.zoneType } : {}),
        ...(options.cityCode ? { city: { code: options.cityCode } } : {}),
      },
      include: {
        city: true,
        pricingRules: { where: { isActive: true }, select: { id: true } },
      },
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        zoneType: r.zoneType,
        cityCode: r.city.code,
        cityId: r.cityId,
        isActive: r.isActive,
        allowsPickup: r.allowsPickup,
        allowsDropoff: r.allowsDropoff,
        fareRuleCount: r.pricingRules.length,
      })),
    };
  }

  /** Legacy fare-rule dropdown */
  async listActiveServiceZonesByCity(cityCode: string): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      zoneType: string;
      cityCode: string;
      isActive: boolean;
    }>
  > {
    const { data } = await this.listServiceZones({ cityCode, activeOnly: true });
    return data.map((z) => ({
      id: z.id,
      code: z.code,
      name: z.name,
      zoneType: z.zoneType,
      cityCode: z.cityCode,
      isActive: z.isActive,
    }));
  }

  async assertZoneBelongsToCity(serviceZoneId: string, cityCode: string): Promise<void> {
    const zone = await this.databaseService.client.serviceZone.findFirst({
      where: { id: serviceZoneId, city: { code: cityCode } },
    });
    if (!zone) {
      throw new GeographicConflictError(`Service zone does not belong to city ${cityCode}`);
    }
  }

  async getServiceZoneById(id: string): Promise<ServiceZoneDetailDto> {
    const row = await this.databaseService.client.serviceZone.findUnique({
      where: { id },
      include: {
        city: true,
        pricingRules: { where: { isActive: true }, select: { id: true } },
        vehicleTypes: { include: { vehicleType: true } },
      },
    });
    if (!row) throw new ServiceZoneNotFoundError();

    const geo = await this.databaseService.client.$queryRaw<Array<{ boundary: string }>>`
      SELECT ST_AsGeoJSON(boundary::geometry) AS boundary FROM service_zones WHERE id = ${id}::uuid
    `;
    const parsed = JSON.parse(geo[0]?.boundary ?? '{"coordinates":[]}') as {
      coordinates: number[][][];
    };

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      zoneType: row.zoneType,
      cityCode: row.city.code,
      cityId: row.cityId,
      isActive: row.isActive,
      allowsPickup: row.allowsPickup,
      allowsDropoff: row.allowsDropoff,
      fareRuleCount: row.pricingRules.length,
      boundary: parsed.coordinates,
      vehicleTypeIds: row.vehicleTypes.map((v) => v.vehicleTypeId),
      vehicleTypeCodes: row.vehicleTypes.map((v) => v.vehicleType.code),
    };
  }

  async createServiceZone(body: CreateServiceZoneBody): Promise<ServiceZoneDetailDto> {
    const city = await this.databaseService.client.city.findUnique({
      where: { code: body.cityCode },
    });
    if (!city) throw new GeographicValidationError(`City ${body.cityCode} not found`);

    await assertValidPolygon(this.databaseService, body.coordinates).catch(() => {
      throw new GeographicValidationError('Invalid zone polygon');
    });
    await assertZoneWithinCity(this.databaseService, city.id, body.coordinates).catch(() => {
      throw new GeographicValidationError('Zone must be within city boundary');
    });

    const geoJson = polygonGeoJson(body.coordinates);
    let id: string;
    try {
      const inserted = await this.databaseService.client.$queryRaw<Array<{ id: string }>>`
        INSERT INTO service_zones (
          id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(),
          ${city.id}::uuid,
          ${body.code},
          ${body.name},
          ${body.zoneType}::"ServiceZoneType",
          ST_GeomFromGeoJSON(${geoJson}),
          ${body.allowsPickup ?? true},
          ${body.allowsDropoff ?? true},
          ${body.isActive ?? true},
          NOW(),
          NOW()
        )
        RETURNING id
      `;
      id = inserted[0]!.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2010' &&
        typeof err.meta === 'object' &&
        err.meta !== null &&
        'driverAdapterError' in err.meta
      ) {
        const cause = (err.meta as { driverAdapterError?: { cause?: { kind?: string } } })
          .driverAdapterError?.cause;
        if (cause?.kind === 'UniqueConstraintViolation') {
          throw new GeographicConflictError(
            `Zone code ${body.code} already exists for city ${body.cityCode}`,
          );
        }
      }
      throw err;
    }
    if (body.vehicleTypeIds?.length) {
      await this.syncZoneVehicleTypes(id, body.vehicleTypeIds);
    }
    return this.getServiceZoneById(id);
  }

  async updateServiceZone(id: string, body: UpdateServiceZoneBody): Promise<ServiceZoneDetailDto> {
    const existing = await this.databaseService.client.serviceZone.findUnique({
      where: { id },
      include: { city: true },
    });
    if (!existing) throw new ServiceZoneNotFoundError();

    if (body.coordinates) {
      await assertValidPolygon(this.databaseService, body.coordinates).catch(() => {
        throw new GeographicValidationError('Invalid zone polygon');
      });
      await assertZoneWithinCity(this.databaseService, existing.cityId, body.coordinates).catch(
        () => {
          throw new GeographicValidationError('Zone must be within city boundary');
        },
      );
      const geoJson = polygonGeoJson(body.coordinates);
      await this.databaseService.client.$executeRaw`
        UPDATE service_zones SET boundary = ST_GeomFromGeoJSON(${geoJson}), updated_at = NOW()
        WHERE id = ${id}::uuid
      `;
    }

    await this.databaseService.client.serviceZone.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.zoneType !== undefined ? { zoneType: body.zoneType } : {}),
        ...(body.allowsPickup !== undefined ? { allowsPickup: body.allowsPickup } : {}),
        ...(body.allowsDropoff !== undefined ? { allowsDropoff: body.allowsDropoff } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });

    if (body.vehicleTypeIds) {
      await this.syncZoneVehicleTypes(id, body.vehicleTypeIds);
    }

    return this.getServiceZoneById(id);
  }

  async activateServiceZone(id: string): Promise<ServiceZoneDetailDto> {
    return this.updateServiceZone(id, { isActive: true });
  }

  async deactivateServiceZone(id: string): Promise<ServiceZoneDetailDto> {
    return this.updateServiceZone(id, { isActive: false });
  }

  private async syncZoneVehicleTypes(zoneId: string, vehicleTypeIds: string[]): Promise<void> {
    await this.databaseService.client.serviceZoneVehicleType.deleteMany({
      where: { serviceZoneId: zoneId },
    });
    if (vehicleTypeIds.length === 0) return;
    await this.databaseService.client.serviceZoneVehicleType.createMany({
      data: vehicleTypeIds.map((vehicleTypeId) => ({ serviceZoneId: zoneId, vehicleTypeId })),
      skipDuplicates: true,
    });
  }
}
