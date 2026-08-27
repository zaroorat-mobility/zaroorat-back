import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { generateUniqueCode } from './code.util.js';
import {
  ReferralProgramConflictError,
  ReferralProgramNotFoundError,
  ReferralMilestoneNotFoundError,
} from './referral.errors.js';
import type {
  CreateMilestoneBody,
  CreateProgramBody,
  ListProgramsQuery,
  UpdateMilestoneBody,
  UpdateProgramBody,
} from './schemas.js';

function toNum(value: { toString(): string } | number | null | undefined): number | null {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

export interface MilestoneDto {
  id: string;
  programId: string;
  name: string;
  requiredReferrals: number;
  bonusAmount: number;
  rewardType: string;
  isActive: boolean;
  createdAt: string;
}

export interface ProgramDto {
  id: string;
  code: string;
  name: string | null;
  referrerReward: number;
  refereeReward: number;
  rewardType: string;
  qualifyingEvent: string;
  qualifyingThreshold: number;
  maxReferralsPerUser: number | null;
  rewardExpiryDays: number | null;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  status: 'active' | 'inactive';
  createdAt: string;
  milestones: MilestoneDto[];
  codesCount: number;
  referralsCount: number;
}

export class AdminReferralProgramService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toMilestoneDto(row: {
    id: string;
    programId: string;
    name: string;
    requiredReferrals: number;
    bonusAmount: { toString(): string };
    rewardType: string;
    isActive: boolean;
    createdAt: Date;
  }): MilestoneDto {
    return {
      id: row.id,
      programId: row.programId,
      name: row.name,
      requiredReferrals: row.requiredReferrals,
      bonusAmount: toNum(row.bonusAmount) ?? 0,
      rewardType: row.rewardType,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toDto(row: {
    id: string;
    code: string;
    name: string | null;
    referrerReward: { toString(): string };
    refereeReward: { toString(): string };
    rewardType: string;
    qualifyingEvent: string;
    qualifyingThreshold: number;
    maxReferralsPerUser: number | null;
    rewardExpiryDays: number | null;
    validFrom: Date;
    validTo: Date;
    isActive: boolean;
    createdAt: Date;
    milestones?: Array<{
      id: string;
      programId: string;
      name: string;
      requiredReferrals: number;
      bonusAmount: { toString(): string };
      rewardType: string;
      isActive: boolean;
      createdAt: Date;
    }>;
    _count?: { codes: number; referrals: number };
  }): ProgramDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      referrerReward: toNum(row.referrerReward) ?? 0,
      refereeReward: toNum(row.refereeReward) ?? 0,
      rewardType: row.rewardType,
      qualifyingEvent: row.qualifyingEvent,
      qualifyingThreshold: row.qualifyingThreshold,
      maxReferralsPerUser: row.maxReferralsPerUser,
      rewardExpiryDays: row.rewardExpiryDays,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo.toISOString(),
      isActive: row.isActive,
      status: row.isActive ? 'active' : 'inactive',
      createdAt: row.createdAt.toISOString(),
      milestones: (row.milestones ?? []).map((m) => this.toMilestoneDto(m)),
      codesCount: row._count?.codes ?? 0,
      referralsCount: row._count?.referrals ?? 0,
    };
  }

  private include = {
    milestones: { orderBy: { requiredReferrals: 'asc' as const } },
    _count: { select: { codes: true, referrals: true } },
  };

  async list(query: ListProgramsQuery): Promise<{
    data: ProgramDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.ReferralProgramWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const totalCount = await this.databaseService.client.referralProgram.count({ where });
    const rows = await this.databaseService.client.referralProgram.findMany({
      where,
      include: this.include,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: rows.map((r) => this.toDto(r)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<ProgramDto> {
    const row = await this.databaseService.client.referralProgram.findUnique({
      where: { id },
      include: this.include,
    });
    if (!row) throw new ReferralProgramNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateProgramBody): Promise<ProgramDto> {
    let code = body.code?.trim().toUpperCase();
    if (!code) code = generateUniqueCode(body.name, 'REF');
    const existing = await this.databaseService.client.referralProgram.findUnique({
      where: { code },
    });
    if (existing) {
      if (body.code)
        throw new ReferralProgramConflictError(`Program code "${code}" already exists`);
      code = generateUniqueCode(body.name, 'REF');
    }

    const row = await this.databaseService.client.referralProgram.create({
      data: {
        code,
        name: body.name ?? null,
        referrerReward: body.referrerReward ?? 0,
        refereeReward: body.refereeReward ?? 0,
        rewardType: body.rewardType ?? 'WALLET',
        qualifyingEvent: body.qualifyingEvent ?? 'FIRST_RIDE',
        qualifyingThreshold: body.qualifyingThreshold ?? 1,
        maxReferralsPerUser: body.maxReferralsPerUser ?? null,
        rewardExpiryDays: body.rewardExpiryDays ?? null,
        validFrom: body.validFrom,
        validTo: body.validTo,
        isActive: body.isActive ?? true,
      },
      include: this.include,
    });
    return this.toDto(row);
  }

  async update(id: string, body: UpdateProgramBody): Promise<ProgramDto> {
    const existing = await this.databaseService.client.referralProgram.findUnique({
      where: { id },
    });
    if (!existing) throw new ReferralProgramNotFoundError();

    if (body.code) {
      const code = body.code.trim().toUpperCase();
      const clash = await this.databaseService.client.referralProgram.findFirst({
        where: { code, id: { not: id } },
      });
      if (clash) throw new ReferralProgramConflictError(`Program code "${code}" already exists`);
    }

    const row = await this.databaseService.client.referralProgram.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.referrerReward !== undefined ? { referrerReward: body.referrerReward } : {}),
        ...(body.refereeReward !== undefined ? { refereeReward: body.refereeReward } : {}),
        ...(body.rewardType !== undefined ? { rewardType: body.rewardType } : {}),
        ...(body.qualifyingEvent !== undefined ? { qualifyingEvent: body.qualifyingEvent } : {}),
        ...(body.qualifyingThreshold !== undefined
          ? { qualifyingThreshold: body.qualifyingThreshold }
          : {}),
        ...(body.maxReferralsPerUser !== undefined
          ? { maxReferralsPerUser: body.maxReferralsPerUser }
          : {}),
        ...(body.rewardExpiryDays !== undefined ? { rewardExpiryDays: body.rewardExpiryDays } : {}),
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom } : {}),
        ...(body.validTo !== undefined ? { validTo: body.validTo } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include: this.include,
    });
    return this.toDto(row);
  }

  async activate(id: string): Promise<ProgramDto> {
    return this.update(id, { isActive: true });
  }

  async deactivate(id: string): Promise<ProgramDto> {
    return this.update(id, { isActive: false });
  }

  async addMilestone(programId: string, body: CreateMilestoneBody): Promise<MilestoneDto> {
    const program = await this.databaseService.client.referralProgram.findUnique({
      where: { id: programId },
    });
    if (!program) throw new ReferralProgramNotFoundError();

    const row = await this.databaseService.client.referralMilestone.create({
      data: {
        programId,
        name: body.name,
        requiredReferrals: body.requiredReferrals,
        bonusAmount: body.bonusAmount,
        rewardType: body.rewardType ?? 'WALLET',
        isActive: body.isActive ?? true,
      },
    });
    return this.toMilestoneDto(row);
  }

  async updateMilestone(id: string, body: UpdateMilestoneBody): Promise<MilestoneDto> {
    const existing = await this.databaseService.client.referralMilestone.findUnique({
      where: { id },
    });
    if (!existing) throw new ReferralMilestoneNotFoundError();

    const row = await this.databaseService.client.referralMilestone.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.requiredReferrals !== undefined
          ? { requiredReferrals: body.requiredReferrals }
          : {}),
        ...(body.bonusAmount !== undefined ? { bonusAmount: body.bonusAmount } : {}),
        ...(body.rewardType !== undefined ? { rewardType: body.rewardType } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    return this.toMilestoneDto(row);
  }

  async deactivateMilestone(id: string): Promise<MilestoneDto> {
    return this.updateMilestone(id, { isActive: false });
  }

  async activateMilestone(id: string): Promise<MilestoneDto> {
    return this.updateMilestone(id, { isActive: true });
  }
}
