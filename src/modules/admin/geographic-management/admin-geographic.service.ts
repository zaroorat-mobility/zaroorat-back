import { DatabaseService } from '@core/database';
import type { ProviderClient } from '@core/database/index.js';
import { uuidV7 } from '@shared/crypto';
import { recordAdminAction } from '../audit/index.js';
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

/// The subset of the client `syncZoneVehicleTypes` needs, so it can run either
/// standalone or inside a transaction handle.
type ZoneVehicleTypeWriter = Pick<ProviderClient, 'serviceZoneVehicleType'>;

/// The driver adapter reports a unique violation as `P2010` with the real cause
/// nested, because the insert goes through raw SQL rather than through Prisma's
/// query builder. Without unwrapping it, a duplicate zone code surfaced as a 500.
function isUniqueViolation(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2010' ||
    typeof err.meta !== 'object' ||
    err.meta === null ||
    !('driverAdapterError' in err.meta)
  ) {
    return false;
  }
  const cause = (err.meta as { driverAdapterError?: { cause?: { kind?: string } } })
    .driverAdapterError?.cause;
  return cause?.kind === 'UniqueConstraintViolation';
}

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

  async createState(body: CreateStateBody, actorId?: string): Promise<StateDto> {
    const country = await this.databaseService.client.country.findUnique({
      where: { code: body.countryCode },
    });
    if (!country) throw new GeographicValidationError(`Country ${body.countryCode} not found`);

    const created = await this.databaseService.transactionManager.execute(async (tx) => {
      const row = await tx.state.create({
        data: {
          countryId: country.id,
          code: body.code.toUpperCase(),
          name: body.name,
          isActive: body.isActive ?? true,
        },
        include: { country: true },
      });
      const dto: StateDto = {
        id: row.id,
        countryCode: row.country.code,
        code: row.code,
        name: row.name,
        isActive: row.isActive,
      };
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'state',
        entityId: row.id,
        summary: `Created state ${row.code}`,
        after: dto,
      });
      return dto;
    });
    return created;
  }

  async updateState(id: string, body: UpdateStateBody, actorId?: string): Promise<StateDto> {
    const existing = await this.databaseService.client.state.findUnique({
      where: { id },
      include: { country: true },
    });
    if (!existing) throw new StateNotFoundError();

    const before: StateDto = {
      id: existing.id,
      countryCode: existing.country.code,
      code: existing.code,
      name: existing.name,
      isActive: existing.isActive,
    };

    return this.databaseService.transactionManager.execute(async (tx) => {
      const updated = await tx.state.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
        include: { country: true },
      });
      const after: StateDto = {
        id: updated.id,
        countryCode: updated.country.code,
        code: updated.code,
        name: updated.name,
        isActive: updated.isActive,
      };
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'state',
        entityId: id,
        summary: `Updated state ${after.code}`,
        before,
        after,
      });
      return after;
    });
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

  /// FR-031. The row and its two PostGIS columns are one change.
  ///
  /// Prisma cannot write `geography` columns, so a city is created by a `create`
  /// followed by raw `UPDATE`s. Untransacted, a failure between them left a city
  /// row with no boundary — and if it was created active, an active city with no
  /// boundary is exactly the state FR-030 exists to prevent, reached by a path
  /// FR-030 does not guard.
  async createCity(body: CreateCityBody, actorId?: string): Promise<CityDetailDto> {
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

    const createdId = await this.databaseService.transactionManager.execute(async (tx) => {
      const created = await tx.city.create({
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
        await tx.$executeRaw`
          UPDATE cities SET center = ST_GeomFromGeoJSON(${centerJson}) WHERE id = ${created.id}::uuid
        `;
      }
      if (body.boundary) {
        const boundaryJson = polygonGeoJson(body.boundary);
        await tx.$executeRaw`
          UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson}) WHERE id = ${created.id}::uuid
        `;
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'city',
        entityId: created.id,
        summary: `Created city ${created.code}`,
        after: {
          code: created.code,
          name: created.name,
          isActive: created.isActive,
          timezone: created.timezone,
          currency: created.currency,
          stateId: created.stateId,
          hasBoundary: Boolean(body.boundary),
        },
      });

      return created.id;
    });

    return this.getCityById(createdId);
  }

  async updateCity(id: string, body: UpdateCityBody, actorId?: string): Promise<CityDetailDto> {
    const existing = await this.databaseService.client.city.findUnique({ where: { id } });
    if (!existing) throw new CityNotFoundError();

    /// FR-029. `City.code` is a natural key that other tables reference as a
    /// plain string with no foreign key: `pricing_rules.city_code`,
    /// `surge_zones.city_code`, the promotion and coupon city columns, and the
    /// analytics rollups. Renaming a city therefore orphaned every fare rule,
    /// promotion and surge polygon in it — silently, because a rule whose
    /// `city_code` matches nothing is not an error. It simply never resolves
    /// again, and the city quietly falls back to GLOBAL pricing.
    ///
    /// Making the code immutable is the cheap half of the requirement. Turning
    /// those columns into real foreign keys is the other half, and is a
    /// migration this feature does not own.
    if (body.code !== undefined && body.code.toUpperCase() !== existing.code) {
      throw new GeographicConflictError(
        `City code cannot be changed: ${existing.code} is referenced by fare rules, promotions and surge zones`,
      );
    }

    /// FR-030. This guard used to be unreachable. The outer condition required
    /// `body.boundary === null` and the inner one required the same value to be
    /// `undefined`, so no request could satisfy both — and `updateCityBodySchema`
    /// does not accept null at all, so the outer test was never true. Any city
    /// could be activated with no polygon, after which every containment query
    /// against it returned nothing and the city served no zones whatsoever.
    const nextActive = body.isActive ?? existing.isActive;
    if (nextActive && existing.code !== 'GLOBAL' && !body.boundary) {
      const geo = await this.databaseService.client.$queryRaw<Array<{ has_boundary: boolean }>>`
        SELECT boundary IS NOT NULL AS has_boundary FROM cities WHERE id = ${id}::uuid
      `;
      if (!geo[0]?.has_boundary) {
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

    await this.databaseService.transactionManager.execute(async (tx) => {
      const updated = await tx.city.update({
        where: { id },
        data: {
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
        await tx.$executeRaw`
          UPDATE cities SET center = ST_GeomFromGeoJSON(${centerJson}) WHERE id = ${id}::uuid
        `;
      }
      if (body.boundary) {
        const boundaryJson = polygonGeoJson(body.boundary);
        await tx.$executeRaw`
          UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson}) WHERE id = ${id}::uuid
        `;
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'city',
        entityId: id,
        summary: `Updated city ${existing.code}`,
        before: {
          name: existing.name,
          isActive: existing.isActive,
          timezone: existing.timezone,
          currency: existing.currency,
          stateId: existing.stateId,
          launchedAt: existing.launchedAt,
        },
        after: {
          name: updated.name,
          isActive: updated.isActive,
          timezone: updated.timezone,
          currency: updated.currency,
          stateId: updated.stateId,
          launchedAt: updated.launchedAt,
          ...(body.boundary ? { boundaryReplaced: true } : {}),
        },
      });
    });

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

  /// FR-031. The zone row and its vehicle-type links are one change.
  ///
  /// Untransacted, a failed `syncZoneVehicleTypes` left a live zone serving no
  /// vehicle types, which reads at the API as a zone that exists and covers
  /// nothing — indistinguishable from a deliberately empty one.
  async createServiceZone(
    body: CreateServiceZoneBody,
    actorId?: string,
  ): Promise<ServiceZoneDetailDto> {
    const city = await this.databaseService.client.city.findUnique({
      where: { code: body.cityCode },
    });
    if (!city) throw new GeographicValidationError(`City ${body.cityCode} not found`);

    await assertValidPolygon(this.databaseService, body.coordinates).catch(() => {
      throw new GeographicValidationError('Invalid zone polygon');
    });
    /// FR-042. Now throws when the city has no boundary rather than treating an
    /// unanswerable containment question as a satisfied one.
    await assertZoneWithinCity(this.databaseService, city.id, body.coordinates).catch(() => {
      throw new GeographicValidationError('Zone must be within city boundary');
    });

    const geoJson = polygonGeoJson(body.coordinates);
    const id = await this.databaseService.transactionManager.execute(async (tx) => {
      let zoneId: string;
      try {
        // D5. `@default(uuid(7))` is generated by the Prisma client, not by the
        // database — `service_zones.id` has no column default at all — so
        // `gen_random_uuid()` here was not overriding a default, it was the only
        // thing supplying an id, and it made this one table's ids v4 while every
        // Prisma-written row in the schema is v7. `uuidV7` is the generator the
        // rest of the codebase already uses.
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO service_zones (
            id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at
          )
          VALUES (
            ${uuidV7()}::uuid,
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
        zoneId = inserted[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new GeographicConflictError(
            `Zone code ${body.code} already exists for city ${body.cityCode}`,
          );
        }
        throw err;
      }

      if (body.vehicleTypeIds?.length) {
        await this.syncZoneVehicleTypes(zoneId, body.vehicleTypeIds, tx);
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'service_zone',
        entityId: zoneId,
        summary: `Created service zone ${body.code} in ${body.cityCode}`,
        after: {
          code: body.code,
          name: body.name,
          zoneType: body.zoneType,
          cityCode: body.cityCode,
          allowsPickup: body.allowsPickup ?? true,
          allowsDropoff: body.allowsDropoff ?? true,
          isActive: body.isActive ?? true,
          vehicleTypeIds: body.vehicleTypeIds ?? [],
        },
      });

      return zoneId;
    });

    return this.getServiceZoneById(id);
  }

  async updateServiceZone(
    id: string,
    body: UpdateServiceZoneBody,
    actorId?: string,
  ): Promise<ServiceZoneDetailDto> {
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
    }

    /// FR-031. The boundary write, the column write and the vehicle-type sync
    /// are one change. `syncZoneVehicleTypes` deletes before it inserts, so an
    /// untransacted failure between the two left the zone serving nothing.
    await this.databaseService.transactionManager.execute(async (tx) => {
      if (body.coordinates) {
        const geoJson = polygonGeoJson(body.coordinates);
        await tx.$executeRaw`
          UPDATE service_zones SET boundary = ST_GeomFromGeoJSON(${geoJson}), updated_at = NOW()
          WHERE id = ${id}::uuid
        `;
      }

      const updated = await tx.serviceZone.update({
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
        await this.syncZoneVehicleTypes(id, body.vehicleTypeIds, tx);
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'service_zone',
        entityId: id,
        summary: `Updated service zone ${existing.code} in ${existing.city.code}`,
        before: {
          name: existing.name,
          zoneType: existing.zoneType,
          allowsPickup: existing.allowsPickup,
          allowsDropoff: existing.allowsDropoff,
          isActive: existing.isActive,
        },
        after: {
          name: updated.name,
          zoneType: updated.zoneType,
          allowsPickup: updated.allowsPickup,
          allowsDropoff: updated.allowsDropoff,
          isActive: updated.isActive,
          ...(body.coordinates ? { boundaryReplaced: true } : {}),
          ...(body.vehicleTypeIds ? { vehicleTypeIds: body.vehicleTypeIds } : {}),
        },
      });
    });

    return this.getServiceZoneById(id);
  }

  async activateServiceZone(id: string, actorId?: string): Promise<ServiceZoneDetailDto> {
    return this.updateServiceZone(id, { isActive: true }, actorId);
  }

  async deactivateServiceZone(id: string, actorId?: string): Promise<ServiceZoneDetailDto> {
    return this.updateServiceZone(id, { isActive: false }, actorId);
  }

  private async syncZoneVehicleTypes(
    zoneId: string,
    vehicleTypeIds: string[],
    tx: ZoneVehicleTypeWriter = this.databaseService.client,
  ): Promise<void> {
    await tx.serviceZoneVehicleType.deleteMany({ where: { serviceZoneId: zoneId } });
    if (vehicleTypeIds.length === 0) return;
    await tx.serviceZoneVehicleType.createMany({
      data: vehicleTypeIds.map((vehicleTypeId) => ({ serviceZoneId: zoneId, vehicleTypeId })),
      skipDuplicates: true,
    });
  }
}
