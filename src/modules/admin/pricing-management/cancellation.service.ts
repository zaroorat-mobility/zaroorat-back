import { DatabaseService } from '@core/database';
import {
  CancellationPolicyConflictError,
  CancellationPolicyNotFoundError,
} from './pricing.errors.js';
import type {
  CreateCancellationPolicyBody,
  ListCancellationPoliciesQuery,
  UpdateCancellationPolicyBody,
} from './cancellation.schemas.js';

const ACTOR_MAP: Record<string, string> = {
  rider: 'RIDER',
  driver: 'DRIVER',
  RIDER: 'RIDER',
  DRIVER: 'DRIVER',
};

const SCENARIO_MAP: Record<string, string> = {
  before_assignment: 'BEFORE_ASSIGNMENT',
  after_assignment: 'AFTER_ASSIGNMENT',
  after_arrival: 'AFTER_ARRIVAL',
  no_show: 'NO_SHOW',
  BEFORE_ASSIGNMENT: 'BEFORE_ASSIGNMENT',
  AFTER_ASSIGNMENT: 'AFTER_ASSIGNMENT',
  AFTER_ARRIVAL: 'AFTER_ARRIVAL',
  NO_SHOW: 'NO_SHOW',
};

const FEE_MAP: Record<string, string> = {
  fixed: 'FLAT',
  percentage: 'PERCENT',
  FLAT: 'FLAT',
  PERCENT: 'PERCENT',
};

const UI_TO_CODE: Record<string, string> = {
  cab: 'CAB_ECONOMY',
  auto: 'AUTO',
  bike: 'BIKE',
  CAB_ECONOMY: 'CAB_ECONOMY',
  AUTO: 'AUTO',
  BIKE: 'BIKE',
};

export interface CancellationPolicyDto {
  id: string;
  ruleName: string;
  actor: 'rider' | 'driver';
  scenario: 'before_assignment' | 'after_assignment' | 'after_arrival' | 'no_show';
  chargeType: 'fixed' | 'percentage';
  chargeAmount: number;
  freeCancelWindowSec: number;
  status: 'active' | 'inactive';
  cityCode?: string;
  vehicleType?: 'cab' | 'auto' | 'bike';
  createdAt: string;
  updatedAt: string;
}

function toNum(value: { toString(): string } | number): number {
  return typeof value === 'number' ? value : Number(value.toString());
}

function actorUi(value: string): 'rider' | 'driver' {
  return value.toUpperCase() === 'DRIVER' ? 'driver' : 'rider';
}

function scenarioUi(
  value: string | null,
): 'before_assignment' | 'after_assignment' | 'after_arrival' | 'no_show' {
  const key = (value ?? 'AFTER_ASSIGNMENT').toUpperCase();
  if (key === 'BEFORE_ASSIGNMENT') return 'before_assignment';
  if (key === 'AFTER_ARRIVAL') return 'after_arrival';
  if (key === 'NO_SHOW') return 'no_show';
  return 'after_assignment';
}

function feeUi(value: string): 'fixed' | 'percentage' {
  return value.toUpperCase() === 'PERCENT' ? 'percentage' : 'fixed';
}

export class AdminCancellationService {
  constructor(private readonly databaseService: DatabaseService) {}

  async list(query: ListCancellationPoliciesQuery): Promise<{
    data: CancellationPolicyDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const rows = await this.databaseService.client.cancellationPolicy.findMany({
      orderBy: { createdAt: 'desc' },
    });

    let data = rows
      .filter((row) => {
        if (query.status === 'active') return row.isActive;
        if (query.status === 'inactive') return !row.isActive;
        return true;
      })
      .map((row) => this.toDto(row));

    if (query.search) {
      const q = query.search.toLowerCase();
      data = data.filter((row) => row.ruleName.toLowerCase().includes(q));
    }

    const totalCount = data.length;
    const skip = (query.page - 1) * query.limit;
    const pageRows = data.slice(skip, skip + query.limit);

    return {
      data: pageRows,
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<CancellationPolicyDto> {
    const row = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!row) throw new CancellationPolicyNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateCancellationPolicyBody): Promise<CancellationPolicyDto> {
    const cancelledBy = ACTOR_MAP[body.actor] ?? 'RIDER';
    const minStatus = SCENARIO_MAP[body.scenario] ?? 'AFTER_ASSIGNMENT';
    const feeType = FEE_MAP[body.chargeType] ?? 'FLAT';
    const isActive = body.status !== 'inactive';
    const vehicleTypeId = body.vehicleType
      ? (await this.resolveVehicleType(body.vehicleType)).id
      : null;
    const cityCode = body.cityCode ?? null;

    if (isActive) {
      await this.databaseService.client.cancellationPolicy.updateMany({
        where: {
          cancelledBy,
          minStatus,
          cityCode,
          vehicleTypeId,
          isActive: true,
        },
        data: { isActive: false },
      });
    }

    const created = await this.databaseService.client.cancellationPolicy.create({
      data: {
        cancelledBy,
        minStatus,
        feeType,
        feeAmount: body.chargeAmount,
        freeCancelWindowSec: body.freeCancelWindowSec ?? 120,
        cityCode,
        vehicleTypeId,
        isActive,
      },
    });
    return this.toDto(created);
  }

  async update(id: string, body: UpdateCancellationPolicyBody): Promise<CancellationPolicyDto> {
    const existing = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new CancellationPolicyNotFoundError();

    const cancelledBy = body.actor
      ? (ACTOR_MAP[body.actor] ?? existing.cancelledBy)
      : existing.cancelledBy;
    const minStatus = body.scenario
      ? (SCENARIO_MAP[body.scenario] ?? existing.minStatus)
      : existing.minStatus;
    const feeType = body.chargeType
      ? (FEE_MAP[body.chargeType] ?? existing.feeType)
      : existing.feeType;
    const isActive = body.status !== undefined ? body.status === 'active' : existing.isActive;
    const vehicleTypeId =
      body.vehicleType !== undefined
        ? body.vehicleType
          ? (await this.resolveVehicleType(body.vehicleType)).id
          : null
        : existing.vehicleTypeId;
    const cityCode = body.cityCode !== undefined ? body.cityCode : existing.cityCode;

    if (isActive) {
      await this.databaseService.client.cancellationPolicy.updateMany({
        where: {
          cancelledBy,
          minStatus,
          cityCode,
          vehicleTypeId,
          isActive: true,
          NOT: { id },
        },
        data: { isActive: false },
      });
    }

    const updated = await this.databaseService.client.cancellationPolicy.update({
      where: { id },
      data: {
        cancelledBy,
        minStatus,
        feeType,
        feeAmount: body.chargeAmount ?? existing.feeAmount,
        freeCancelWindowSec: body.freeCancelWindowSec ?? existing.freeCancelWindowSec,
        cityCode,
        vehicleTypeId,
        isActive,
      },
    });
    return this.toDto(updated);
  }

  async activate(id: string): Promise<CancellationPolicyDto> {
    const existing = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new CancellationPolicyNotFoundError();

    await this.databaseService.client.cancellationPolicy.updateMany({
      where: {
        cancelledBy: existing.cancelledBy,
        minStatus: existing.minStatus,
        cityCode: existing.cityCode,
        vehicleTypeId: existing.vehicleTypeId,
        isActive: true,
      },
      data: { isActive: false },
    });

    const updated = await this.databaseService.client.cancellationPolicy.update({
      where: { id },
      data: { isActive: true },
    });
    return this.toDto(updated);
  }

  async deactivate(id: string): Promise<CancellationPolicyDto> {
    const existing = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new CancellationPolicyNotFoundError();
    const updated = await this.databaseService.client.cancellationPolicy.update({
      where: { id },
      data: { isActive: false },
    });
    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    await this.deactivate(id);
  }

  private async resolveVehicleType(raw: string) {
    const code = UI_TO_CODE[raw] ?? raw.toUpperCase();
    const vehicleType = await this.databaseService.client.vehicleType.findUnique({
      where: { code },
    });
    if (!vehicleType) {
      throw new CancellationPolicyConflictError(`Vehicle type ${code} is not configured`);
    }
    return vehicleType;
  }

  private toDto(row: {
    id: string;
    cancelledBy: string;
    minStatus: string | null;
    feeAmount: { toString(): string };
    feeType: string;
    freeCancelWindowSec: number;
    isActive: boolean;
    cityCode: string | null;
    createdAt: Date;
  }): CancellationPolicyDto {
    const actor = actorUi(row.cancelledBy);
    const scenario = scenarioUi(row.minStatus);
    const chargeType = feeUi(row.feeType);
    return {
      id: row.id,
      ruleName: `${actor} · ${scenario.replace(/_/g, ' ')}`,
      actor,
      scenario,
      chargeType,
      chargeAmount: toNum(row.feeAmount),
      freeCancelWindowSec: row.freeCancelWindowSec,
      status: row.isActive ? 'active' : 'inactive',
      ...(row.cityCode ? { cityCode: row.cityCode } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.createdAt.toISOString(),
    };
  }
}
