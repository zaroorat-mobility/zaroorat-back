import { Prisma } from '../../../../generated/prisma/index.js';
import type { DatabaseService } from '@core/database';
import type { SurgeZone } from '../../../../generated/prisma/index.js';
import { assertValidPolygon, polygonGeoJson } from '@modules/location';
import { uuidV7 } from '@shared/crypto';
import { recordAdminAction } from '../../audit/index.js';
import {
  PricingAdminError,
  SurgeCityNotFoundError,
  SurgeWindowNotFoundError,
  SurgeZoneNotFoundError,
} from '../pricing.errors.js';
import {
  VehicleTypeService,
  vehicleTypeDisplayName,
} from '@modules/vehicles/services/vehicle-type.service.js';
import type { ListSurgeWindowsQuery } from './surge.schema.js';

export interface SurgeVehicleSummary {
  id: string;
  code: string;
  name: string;
}

/// FR-014 + Phase 2.3 (M-08): Admin view of a surge window with multi-vehicle,
/// citywide scope, and revision lineage metadata.
export interface SurgeWindowDto {
  id: string;
  serviceZoneId: string | null;
  /// @deprecated BD-4. Null for windows created against a service zone or city.
  zoneId: string | null;
  cityCode: string | null;
  vehicleTypeId: string | null;
  vehicleTypeIds: string[];
  vehicleTypes: SurgeVehicleSummary[];
  multiplier: Prisma.Decimal;
  source: string;
  reason: string | null;
  peakHourStart: string | null;
  peakHourEnd: string | null;
  isPeakHourOnly: boolean;
  daysOfWeek: number[];
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  supersedesId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  zoneName?: string | undefined;
  vehicleTypeCode?: string | null | undefined;
  vehicleTypeName?: string | null | undefined;
}

export interface SurgeZoneDetail extends Pick<
  SurgeZone,
  'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'
> {
  boundary: number[][][];
  center?: { lat: number; lng: number } | null;
}

function parseHhMmMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
  return h * 60 + m;
}

function dailyIntervalsOverlap(
  aPeakOnly: boolean,
  aStart: string | null | undefined,
  aEnd: string | null | undefined,
  bPeakOnly: boolean,
  bStart: string | null | undefined,
  bEnd: string | null | undefined,
): boolean {
  if (!aPeakOnly || !bPeakOnly) return true;
  const toSegments = (
    s: string | null | undefined,
    e: string | null | undefined,
  ): Array<[number, number]> => {
    const start = parseHhMmMinutes(s);
    const end = parseHhMmMinutes(e);
    if (start === null || end === null) return [[0, 1440]];
    if (start < end) return [[start, end]];
    if (start > end)
      return [
        [start, 1440],
        [0, end],
      ];
    return [[0, 1440]];
  };
  const segA = toSegments(aStart, aEnd);
  const segB = toSegments(bStart, bEnd);
  return segA.some(([a1, a2]) => segB.some(([b1, b2]) => a1 < b2 && b1 < a2));
}

interface SurgeWindowRow {
  id: string;
  serviceZoneId: string | null;
  zoneId: string | null;
  cityCode: string | null;
  vehicleTypeId: string | null;
  vehicleTypeIds: string[];
  multiplier: Prisma.Decimal;
  source: string;
  reason: string | null;
  peakHourStart: string | null;
  peakHourEnd: string | null;
  isPeakHourOnly: boolean;
  daysOfWeek: number[];
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  supersedesId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  zone?: { name: string } | null;
  serviceZone?: { name: string } | null;
  vehicleType?: { id: string; code: string; name: string; hasAc: boolean } | null;
}

const WINDOW_INCLUDE = {
  zone: { select: { name: true } },
  serviceZone: { select: { name: true } },
  vehicleType: { select: { id: true, code: true, name: true, hasAc: true } },
} as const;

function toWindowDto(
  row: SurgeWindowRow,
  vehicleLookup: Map<string, SurgeVehicleSummary>,
): SurgeWindowDto {
  const effectiveIds =
    row.vehicleTypeIds.length > 0
      ? row.vehicleTypeIds
      : row.vehicleTypeId
        ? [row.vehicleTypeId]
        : [];
  const vehicleTypes: SurgeVehicleSummary[] = effectiveIds
    .map((id) => vehicleLookup.get(id))
    .filter((v): v is SurgeVehicleSummary => Boolean(v));

  const primaryVehicle =
    row.vehicleType != null
      ? {
          code: row.vehicleType.code,
          name: vehicleTypeDisplayName(row.vehicleType),
        }
      : vehicleTypes.length === 1
        ? { code: vehicleTypes[0]!.code, name: vehicleTypes[0]!.name }
        : null;

  const scopeLabel =
    row.serviceZone?.name ??
    row.zone?.name ??
    (row.cityCode ? `${row.cityCode} (Citywide)` : undefined);

  return {
    id: row.id,
    serviceZoneId: row.serviceZoneId,
    zoneId: row.zoneId,
    cityCode: row.cityCode,
    vehicleTypeId: row.vehicleTypeId,
    vehicleTypeIds: effectiveIds,
    vehicleTypes,
    multiplier: row.multiplier,
    source: row.source,
    reason: row.reason,
    peakHourStart: row.peakHourStart,
    peakHourEnd: row.peakHourEnd,
    isPeakHourOnly: row.isPeakHourOnly,
    daysOfWeek: row.daysOfWeek,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isActive: row.isActive,
    supersedesId: row.supersedesId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(scopeLabel ? { zoneName: scopeLabel } : {}),
    vehicleTypeCode: primaryVehicle?.code ?? null,
    vehicleTypeName: primaryVehicle?.name ?? null,
  };
}

export class AdminSurgeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly vehicleTypeService: VehicleTypeService,
  ) {}

  private async loadVehicleLookup(
    rows: readonly SurgeWindowRow[],
  ): Promise<Map<string, SurgeVehicleSummary>> {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.vehicleTypeId) ids.add(row.vehicleTypeId);
      for (const vid of row.vehicleTypeIds) ids.add(vid);
    }
    if (ids.size === 0) return new Map();
    const vehicles = await this.db.client.vehicleType.findMany({
      where: { id: { in: Array.from(ids) } },
      select: { id: true, code: true, name: true, hasAc: true },
    });
    return new Map(
      vehicles.map((v) => [v.id, { id: v.id, code: v.code, name: vehicleTypeDisplayName(v) }]),
    );
  }

  private async validateVehicleIds(
    vehicleTypeIds?: readonly string[],
    vehicleTypeId?: string,
  ): Promise<string[]> {
    const merged = Array.from(
      new Set([...(vehicleTypeIds ?? []), ...(vehicleTypeId ? [vehicleTypeId] : [])]),
    );
    for (const id of merged) {
      await this.vehicleTypeService.resolveForConfig({ id });
    }
    return merged;
  }

  async createSurgeZone(
    data: {
      cityCode: string;
      name: string;
      coordinates: number[][][];
    },
    actorId?: string,
  ): Promise<SurgeZone> {
    await assertValidPolygon(this.db, data.coordinates);
    const geoJson = polygonGeoJson(data.coordinates);

    return this.db.transactionManager.execute(async (tx) => {
      const [zone] = await tx.$queryRaw<SurgeZone[]>`
        INSERT INTO surge_zones (id, city_code, name, boundary)
        VALUES (
          ${uuidV7()}::uuid,
          ${data.cityCode},
          ${data.name},
          ST_GeomFromGeoJSON(${geoJson})
        )
        RETURNING id, city_code AS "cityCode", name, is_active AS "isActive", created_at AS "createdAt"
      `;
      const created = zone as SurgeZone;
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'surge_zone',
        entityId: created.id,
        summary: `Created surge zone ${created.name} in ${created.cityCode}`,
        after: { cityCode: created.cityCode, name: created.name, isActive: created.isActive },
      });
      return created;
    });
  }

  async listSurgeZones(): Promise<SurgeZoneDetail[]> {
    const rows = await this.db.client.$queryRaw<
      Array<
        Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'> & {
          boundary: string | null;
          centerLat: number | null;
          centerLng: number | null;
        }
      >
    >`
      SELECT
        id,
        city_code AS "cityCode",
        name,
        is_active AS "isActive",
        created_at AS "createdAt",
        ST_AsGeoJSON(boundary::geometry) AS boundary,
        ST_Y(ST_Centroid(boundary::geometry)) AS "centerLat",
        ST_X(ST_Centroid(boundary::geometry)) AS "centerLng"
      FROM surge_zones
      WHERE is_active = true
      ORDER BY created_at DESC
    `;

    return rows.map((row) => {
      let coords: number[][][] = [];
      if (row.boundary) {
        try {
          const parsed = JSON.parse(row.boundary) as { coordinates?: number[][][] };
          if (Array.isArray(parsed.coordinates)) coords = parsed.coordinates;
        } catch {
          coords = [];
        }
      }
      return {
        id: row.id,
        cityCode: row.cityCode,
        name: row.name,
        isActive: row.isActive,
        createdAt: row.createdAt,
        boundary: coords,
        center:
          row.centerLat != null && row.centerLng != null
            ? { lat: Number(row.centerLat), lng: Number(row.centerLng) }
            : null,
      };
    });
  }

  async getSurgeZone(id: string): Promise<SurgeZoneDetail> {
    const zones = await this.db.client.$queryRaw<
      Array<
        Pick<SurgeZone, 'id' | 'cityCode' | 'name' | 'isActive' | 'createdAt'> & {
          boundary: string;
        }
      >
    >`
      SELECT
        id,
        city_code AS "cityCode",
        name,
        is_active AS "isActive",
        created_at AS "createdAt",
        ST_AsGeoJSON(boundary::geometry) AS boundary
      FROM surge_zones
      WHERE id = ${id}::uuid
    `;
    const row = zones[0];
    if (!row) throw new SurgeZoneNotFoundError();
    const parsed = JSON.parse(row.boundary) as { coordinates: number[][][] };
    return {
      id: row.id,
      cityCode: row.cityCode,
      name: row.name,
      isActive: row.isActive,
      createdAt: row.createdAt,
      boundary: parsed.coordinates,
    };
  }

  async updateSurgeZone(
    id: string,
    data: {
      name?: string | undefined;
      isActive?: boolean | undefined;
      coordinates?: number[][][] | undefined;
    },
    actorId?: string,
  ): Promise<void> {
    const existing = await this.db.client.surgeZone.findUnique({
      where: { id },
      select: { id: true, name: true, cityCode: true, isActive: true },
    });
    if (!existing) throw new SurgeZoneNotFoundError();

    if (data.coordinates) {
      await assertValidPolygon(this.db, data.coordinates);
    }

    await this.db.transactionManager.execute(async (tx) => {
      if (data.coordinates) {
        const geoJson = polygonGeoJson(data.coordinates);
        await tx.$executeRaw`
          UPDATE surge_zones SET boundary = ST_GeomFromGeoJSON(${geoJson}) WHERE id = ${id}::uuid
        `;
      }

      if (data.name !== undefined || data.isActive !== undefined) {
        await tx.surgeZone.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'surge_zone',
        entityId: id,
        summary: `Updated surge zone ${existing.name}`,
        before: { name: existing.name, isActive: existing.isActive },
        after: {
          name: data.name ?? existing.name,
          isActive: data.isActive ?? existing.isActive,
          ...(data.coordinates ? { boundaryReplaced: true } : {}),
        },
      });
    });
  }

  async deleteSurgeZone(id: string, actorId?: string): Promise<void> {
    await this.updateSurgeZone(id, { isActive: false }, actorId);
  }

  async createSurgeWindow(
    data: {
      serviceZoneId?: string | undefined;
      zoneId?: string | undefined;
      cityCode?: string | undefined;
      vehicleTypeId?: string | undefined;
      vehicleTypeIds?: string[] | undefined;
      multiplier: number;
      startsAt: Date;
      endsAt?: Date | undefined;
      reason?: string | undefined;
      peakHourStart?: string | undefined;
      peakHourEnd?: string | undefined;
      isPeakHourOnly?: boolean | undefined;
      daysOfWeek?: number[] | undefined;
    },
    actorId?: string,
  ): Promise<SurgeWindowDto> {
    const normalizedCity = data.cityCode ? data.cityCode.toUpperCase() : undefined;
    if (!data.serviceZoneId && !data.zoneId && !normalizedCity) {
      throw new PricingAdminError(
        'A surge window requires a serviceZoneId, cityCode, or zoneId',
        'VALIDATION',
        400,
      );
    }
    if (normalizedCity) {
      const city = await this.db.client.city.findUnique({ where: { code: normalizedCity } });
      if (!city) throw new SurgeCityNotFoundError();
    }
    if (data.serviceZoneId) {
      const sz = await this.db.client.serviceZone.findUnique({ where: { id: data.serviceZoneId } });
      if (!sz) throw new SurgeZoneNotFoundError();
    }

    const validatedVehicleIds = await this.validateVehicleIds(
      data.vehicleTypeIds,
      data.vehicleTypeId,
    );
    const singleVehicleId = validatedVehicleIds.length === 1 ? validatedVehicleIds[0]! : null;

    // Strict duplicate/overlap guard: prevent creating an overlapping active surge window
    // on the exact same scope + vehicles + days + daily peak hours.
    const sameScopeActive = await this.db.client.surgeWindow.findMany({
      where: {
        isActive: true,
        serviceZoneId: data.serviceZoneId ?? null,
        zoneId: data.zoneId ?? null,
        cityCode: normalizedCity ?? null,
      },
      include: WINDOW_INCLUDE,
    });
    const newStartMs = data.startsAt.getTime();
    const newEndMs = data.endsAt ? data.endsAt.getTime() : Number.POSITIVE_INFINITY;
    const newDays = data.daysOfWeek ?? [];

    const conflict = sameScopeActive.find((inc) => {
      const incStartMs = inc.startsAt.getTime();
      const incEndMs = inc.endsAt ? inc.endsAt.getTime() : Number.POSITIVE_INFINITY;
      if (!(incEndMs > newStartMs && incStartMs < newEndMs)) return false;

      const incVehicles =
        inc.vehicleTypeIds.length > 0
          ? inc.vehicleTypeIds
          : inc.vehicleTypeId
            ? [inc.vehicleTypeId]
            : [];
      const vehiclesOverlap =
        validatedVehicleIds.length === 0 ||
        incVehicles.length === 0 ||
        validatedVehicleIds.some((id) => incVehicles.includes(id));
      if (!vehiclesOverlap) return false;

      const incDays = inc.daysOfWeek ?? [];
      const daysOverlap =
        newDays.length === 0 || incDays.length === 0 || newDays.some((d) => incDays.includes(d));
      if (!daysOverlap) return false;

      return dailyIntervalsOverlap(
        Boolean(data.isPeakHourOnly),
        data.peakHourStart,
        data.peakHourEnd,
        inc.isPeakHourOnly,
        inc.peakHourStart,
        inc.peakHourEnd,
      );
    });

    if (conflict) {
      const conflictName =
        conflict.reason ||
        conflict.serviceZone?.name ||
        conflict.zone?.name ||
        (conflict.cityCode ? `${conflict.cityCode} (Citywide)` : 'existing rule');
      throw new PricingAdminError(
        `An active surge rule ("${conflictName}" at ${Number(conflict.multiplier).toFixed(2)}x) already covers an overlapping scope, vehicle, and schedule. Edit the existing rule or choose a non-overlapping schedule.`,
        'SURGE_WINDOW_CONFLICT',
        409,
      );
    }

    const created = await this.db.transactionManager.execute(async (tx) => {
      const row = await tx.surgeWindow.create({
        data: {
          ...(data.serviceZoneId !== undefined ? { serviceZoneId: data.serviceZoneId } : {}),
          ...(data.zoneId !== undefined ? { zoneId: data.zoneId } : {}),
          ...(normalizedCity !== undefined ? { cityCode: normalizedCity } : {}),
          vehicleTypeId: singleVehicleId,
          vehicleTypeIds: validatedVehicleIds,
          multiplier: new Prisma.Decimal(data.multiplier),
          startsAt: data.startsAt,
          endsAt: data.endsAt ?? null,
          reason: data.reason ?? null,
          ...(data.peakHourStart !== undefined ? { peakHourStart: data.peakHourStart } : {}),
          ...(data.peakHourEnd !== undefined ? { peakHourEnd: data.peakHourEnd } : {}),
          ...(data.isPeakHourOnly !== undefined ? { isPeakHourOnly: data.isPeakHourOnly } : {}),
          ...(data.daysOfWeek !== undefined ? { daysOfWeek: data.daysOfWeek } : {}),
          ...(actorId ? { createdBy: actorId } : {}),
        },
        include: WINDOW_INCLUDE,
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'surge_window',
        entityId: row.id,
        summary: `Created surge window at ${String(data.multiplier)}x`,
        after: {
          serviceZoneId: row.serviceZoneId,
          zoneId: row.zoneId,
          cityCode: row.cityCode,
          vehicleTypeIds: row.vehicleTypeIds,
          multiplier: row.multiplier,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          peakHourStart: row.peakHourStart,
          peakHourEnd: row.peakHourEnd,
          isPeakHourOnly: row.isPeakHourOnly,
          daysOfWeek: row.daysOfWeek,
        },
      });
      return row;
    });

    const lookup = await this.loadVehicleLookup([created]);
    return toWindowDto(created, lookup);
  }

  async listSurgeWindows(query: ListSurgeWindowsQuery): Promise<{
    data: SurgeWindowDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.SurgeWindowWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.cityCode) {
      const code = query.cityCode.toUpperCase();
      where.OR = [
        { cityCode: code },
        { serviceZone: { city: { code } } },
        { zone: { cityCode: code } },
      ];
    }
    if (query.search) {
      const term = query.search;
      const searchOr: Prisma.SurgeWindowWhereInput[] = [
        { reason: { contains: term, mode: 'insensitive' } },
        { cityCode: { contains: term, mode: 'insensitive' } },
        { serviceZone: { name: { contains: term, mode: 'insensitive' } } },
        { zone: { name: { contains: term, mode: 'insensitive' } } },
      ];
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: searchOr }];
    }

    const [totalCount, rows] = await Promise.all([
      this.db.client.surgeWindow.count({ where }),
      this.db.client.surgeWindow.findMany({
        where,
        include: WINDOW_INCLUDE,
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    const lookup = await this.loadVehicleLookup(rows);
    return {
      data: rows.map((row) => toWindowDto(row, lookup)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getSurgeWindow(id: string): Promise<SurgeWindowDto> {
    const row = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: WINDOW_INCLUDE,
    });
    if (!row) throw new SurgeWindowNotFoundError();
    const lookup = await this.loadVehicleLookup([row]);
    return toWindowDto(row, lookup);
  }

  /// Phase 2.3 (M-08): Returns the ordered revision chain (newest first) for a surge window.
  async listSurgeWindowVersions(id: string): Promise<SurgeWindowDto[]> {
    const anchor = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: WINDOW_INCLUDE,
    });
    if (!anchor) throw new SurgeWindowNotFoundError();

    const chain: SurgeWindowRow[] = [anchor];
    const visited = new Set<string>([anchor.id]);

    // Walk backward through `supersedesId`
    let prevId = anchor.supersedesId;
    while (prevId && !visited.has(prevId)) {
      visited.add(prevId);
      const prev = await this.db.client.surgeWindow.findUnique({
        where: { id: prevId },
        include: WINDOW_INCLUDE,
      });
      if (!prev) break;
      chain.push(prev);
      prevId = prev.supersedesId;
    }

    // Walk forward through `supersededBy`
    let currentId = anchor.id;
    while (true) {
      const next = await this.db.client.surgeWindow.findFirst({
        where: { supersedesId: currentId },
        include: WINDOW_INCLUDE,
      });
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      chain.unshift(next);
      currentId = next.id;
    }

    const lookup = await this.loadVehicleLookup(chain);
    return chain.map((row) => toWindowDto(row, lookup));
  }

  /// Phase 2.3 (M-08): End-and-replace edits preserve full surge history.
  /// - Pure status toggle (`{ isActive }`) updates in place.
  /// - Any schedule, multiplier, vehicle, or scope edit closes the incumbent
  ///   and creates a new successor row linked via `supersedesId`.
  async updateSurgeWindow(
    id: string,
    data: {
      serviceZoneId?: string | null | undefined;
      cityCode?: string | null | undefined;
      vehicleTypeIds?: string[] | undefined;
      multiplier?: number | undefined;
      startsAt?: Date | undefined;
      endsAt?: Date | null | undefined;
      isActive?: boolean | undefined;
      reason?: string | null | undefined;
      peakHourStart?: string | null | undefined;
      peakHourEnd?: string | null | undefined;
      isPeakHourOnly?: boolean | undefined;
      daysOfWeek?: number[] | undefined;
    },
    actorId?: string,
  ): Promise<SurgeWindowDto> {
    const existing = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: WINDOW_INCLUDE,
    });
    if (!existing) throw new SurgeWindowNotFoundError();

    const hasContentChanges =
      data.multiplier !== undefined ||
      data.startsAt !== undefined ||
      data.endsAt !== undefined ||
      data.reason !== undefined ||
      data.peakHourStart !== undefined ||
      data.peakHourEnd !== undefined ||
      data.isPeakHourOnly !== undefined ||
      data.daysOfWeek !== undefined ||
      data.vehicleTypeIds !== undefined ||
      data.cityCode !== undefined ||
      data.serviceZoneId !== undefined;

    if (!hasContentChanges && data.isActive !== undefined) {
      const toggled = await this.db.transactionManager.execute(async (tx) => {
        const updated = await tx.surgeWindow.update({
          where: { id },
          data: { isActive: data.isActive! },
          include: WINDOW_INCLUDE,
        });
        await recordAdminAction(tx, {
          actorId,
          action: 'UPDATE',
          entityType: 'surge_window',
          entityId: id,
          summary: `${data.isActive ? 'Activated' : 'Deactivated'} surge window ${id}`,
          before: { isActive: existing.isActive },
          after: { isActive: data.isActive },
        });
        return updated;
      });
      const lookup = await this.loadVehicleLookup([toggled]);
      return toWindowDto(toggled, lookup);
    }

    const nextCityCode =
      data.cityCode !== undefined
        ? data.cityCode
          ? data.cityCode.toUpperCase()
          : null
        : existing.cityCode;
    if (nextCityCode && data.cityCode !== undefined) {
      const city = await this.db.client.city.findUnique({ where: { code: nextCityCode } });
      if (!city) throw new SurgeCityNotFoundError();
    }

    const nextServiceZoneId =
      data.serviceZoneId !== undefined ? data.serviceZoneId : existing.serviceZoneId;
    if (nextServiceZoneId && data.serviceZoneId !== undefined) {
      const sz = await this.db.client.serviceZone.findUnique({ where: { id: nextServiceZoneId } });
      if (!sz) throw new SurgeZoneNotFoundError();
    }

    const nextVehicleIds =
      data.vehicleTypeIds !== undefined
        ? await this.validateVehicleIds(data.vehicleTypeIds)
        : existing.vehicleTypeIds.length > 0
          ? existing.vehicleTypeIds
          : existing.vehicleTypeId
            ? [existing.vehicleTypeId]
            : [];
    const nextSingleVehicleId = nextVehicleIds.length === 1 ? nextVehicleIds[0]! : null;

    const nextStartsAt = data.startsAt ?? existing.startsAt;
    const nextEndsAt = data.endsAt !== undefined ? data.endsAt : existing.endsAt;
    if (nextEndsAt && nextEndsAt.getTime() <= nextStartsAt.getTime()) {
      throw new PricingAdminError('endsAt must be after startsAt', 'VALIDATION', 400);
    }

    const successor = await this.db.transactionManager.execute(async (tx) => {
      const now = new Date();
      // Close incumbent cleanly while retaining its historical record.
      const incumbentEndsAt =
        existing.startsAt.getTime() <= now.getTime() &&
        (!existing.endsAt || existing.endsAt.getTime() > now.getTime())
          ? now
          : existing.endsAt;

      await tx.surgeWindow.update({
        where: { id },
        data: {
          isActive: false,
          ...(incumbentEndsAt ? { endsAt: incumbentEndsAt } : {}),
        },
      });

      const created = await tx.surgeWindow.create({
        data: {
          serviceZoneId: nextServiceZoneId,
          zoneId: existing.zoneId,
          cityCode: nextCityCode,
          vehicleTypeId: nextSingleVehicleId,
          vehicleTypeIds: nextVehicleIds,
          multiplier:
            data.multiplier !== undefined
              ? new Prisma.Decimal(data.multiplier)
              : existing.multiplier,
          source: existing.source,
          reason: data.reason !== undefined ? data.reason : existing.reason,
          peakHourStart:
            data.peakHourStart !== undefined ? data.peakHourStart : existing.peakHourStart,
          peakHourEnd: data.peakHourEnd !== undefined ? data.peakHourEnd : existing.peakHourEnd,
          isPeakHourOnly:
            data.isPeakHourOnly !== undefined ? data.isPeakHourOnly : existing.isPeakHourOnly,
          daysOfWeek: data.daysOfWeek !== undefined ? data.daysOfWeek : existing.daysOfWeek,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          isActive: data.isActive !== undefined ? data.isActive : existing.isActive,
          supersedesId: existing.id,
          createdBy: actorId ?? existing.createdBy,
        },
        include: WINDOW_INCLUDE,
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'surge_window',
        entityId: created.id,
        summary: `Revised surge window ${existing.id} → ${created.id} (${String(created.multiplier)}x)`,
        before: {
          id: existing.id,
          multiplier: existing.multiplier,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          isActive: existing.isActive,
          vehicleTypeIds: existing.vehicleTypeIds,
          cityCode: existing.cityCode,
          serviceZoneId: existing.serviceZoneId,
          peakHourStart: existing.peakHourStart,
          peakHourEnd: existing.peakHourEnd,
          isPeakHourOnly: existing.isPeakHourOnly,
          daysOfWeek: existing.daysOfWeek,
        },
        after: {
          id: created.id,
          supersedesId: created.supersedesId,
          multiplier: created.multiplier,
          startsAt: created.startsAt,
          endsAt: created.endsAt,
          isActive: created.isActive,
          vehicleTypeIds: created.vehicleTypeIds,
          cityCode: created.cityCode,
          serviceZoneId: created.serviceZoneId,
          peakHourStart: created.peakHourStart,
          peakHourEnd: created.peakHourEnd,
          isPeakHourOnly: created.isPeakHourOnly,
          daysOfWeek: created.daysOfWeek,
        },
      });
      return created;
    });

    const lookup = await this.loadVehicleLookup([successor]);
    return toWindowDto(successor, lookup);
  }

  /// The legal surge limit in one city. A money setting, so it needs pricing:write
  /// rather than the geography permission the rest of the city form uses.
  async updateCitySurgeSettings(
    cityCode: string,
    maxSurgeMultiplier: number,
    actorId?: string,
  ): Promise<{ cityCode: string; maxSurgeMultiplier: number }> {
    const code = cityCode.toUpperCase();
    const existing = await this.db.client.city.findUnique({ where: { code } });
    if (!existing) throw new SurgeCityNotFoundError();

    await this.db.transactionManager.execute(async (tx) => {
      await tx.city.update({
        where: { id: existing.id },
        data: { maxSurgeMultiplier: new Prisma.Decimal(maxSurgeMultiplier) },
      });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'city',
        entityId: existing.id,
        summary: `Set surge cap for ${code} to ${String(maxSurgeMultiplier)}x`,
        before: { maxSurgeMultiplier: Number(existing.maxSurgeMultiplier) },
        after: { maxSurgeMultiplier },
      });
    });
    return { cityCode: code, maxSurgeMultiplier };
  }

  async deleteSurgeWindow(id: string, actorId?: string): Promise<void> {
    const existing = await this.db.client.surgeWindow.findUnique({
      where: { id },
      include: WINDOW_INCLUDE,
    });
    if (!existing) throw new SurgeWindowNotFoundError();

    if (existing.isActive) {
      throw new PricingAdminError(
        'Deactivate this surge rule before deleting it.',
        'SURGE_WINDOW_IS_ACTIVE',
        409,
      );
    }

    const rideReqCount = await this.db.client.rideRequest.count({
      where: { surgeWindowId: id },
    });
    if (rideReqCount > 0) {
      throw new PricingAdminError(
        'This surge rule is referenced by past ride requests and cannot be permanently deleted. Keep it Inactive for billing audit.',
        'SURGE_WINDOW_REFERENCED',
        409,
      );
    }

    await this.db.transactionManager.execute(async (tx) => {
      await tx.surgeWindow.updateMany({
        where: { supersedesId: id },
        data: { supersedesId: existing.supersedesId ?? null },
      });
      await tx.surgeWindow.delete({ where: { id } });
      await recordAdminAction(tx, {
        actorId,
        action: 'DELETE',
        entityType: 'surge_window',
        entityId: id,
        summary: `Deleted inactive surge window ${existing.reason || id} (${String(existing.multiplier)}x)`,
        before: {
          id: existing.id,
          reason: existing.reason,
          multiplier: existing.multiplier,
          cityCode: existing.cityCode,
          zoneId: existing.zoneId,
          serviceZoneId: existing.serviceZoneId,
        },
      });
    });
  }
}
