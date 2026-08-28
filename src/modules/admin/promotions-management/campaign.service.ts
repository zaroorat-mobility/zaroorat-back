import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { generateUniqueCode } from './code.util.js';
import {
  CampaignConflictError,
  CampaignNotFoundError,
  PromotionNotFoundError,
  SegmentNotFoundError,
} from './promotions.errors.js';
import type {
  CreateCampaignBody,
  ListCampaignsQuery,
  SetCampaignTargetsBody,
  UpdateCampaignBody,
} from './schemas.js';

function toNum(value: { toString(): string } | number | null | undefined): number | null {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

export interface CampaignTargetDto {
  id: string;
  segmentId: string;
  segmentCode: string;
  segmentName: string;
  promotionId: string | null;
  promotionCode: string | null;
}

export interface CampaignDto {
  id: string;
  code: string;
  name: string;
  objective: string;
  status: string;
  budget: number | null;
  spent: number;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  targets: CampaignTargetDto[];
}

export class AdminCampaignService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toDto(row: {
    id: string;
    code: string;
    name: string;
    objective: string;
    status: string;
    budget: { toString(): string } | null;
    spent: { toString(): string };
    startsAt: Date | null;
    endsAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    targets?: Array<{
      id: string;
      segmentId: string;
      promotionId: string | null;
      segment: { code: string; name: string };
      promotion: { code: string } | null;
    }>;
  }): CampaignDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      objective: row.objective,
      status: row.status,
      budget: toNum(row.budget),
      spent: toNum(row.spent) ?? 0,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      targets: (row.targets ?? []).map((t) => ({
        id: t.id,
        segmentId: t.segmentId,
        segmentCode: t.segment.code,
        segmentName: t.segment.name,
        promotionId: t.promotionId,
        promotionCode: t.promotion?.code ?? null,
      })),
    };
  }

  private includeTargets = {
    targets: {
      include: {
        segment: true,
        promotion: true,
      },
    },
  } as const;

  async list(query: ListCampaignsQuery): Promise<{
    data: CampaignDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.PromoCampaignWhereInput = {};
    if (query.status !== 'all') where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const totalCount = await this.databaseService.client.promoCampaign.count({ where });
    const rows = await this.databaseService.client.promoCampaign.findMany({
      where,
      include: this.includeTargets,
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

  async getById(id: string): Promise<CampaignDto> {
    const row = await this.databaseService.client.promoCampaign.findUnique({
      where: { id },
      include: this.includeTargets,
    });
    if (!row) throw new CampaignNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateCampaignBody, createdBy?: string): Promise<CampaignDto> {
    let code = body.code?.trim().toUpperCase();
    if (!code) {
      code = generateUniqueCode(body.name, 'CAMP');
    }
    const existing = await this.databaseService.client.promoCampaign.findUnique({
      where: { code },
    });
    if (existing) {
      if (body.code) {
        throw new CampaignConflictError(`Campaign code "${code}" already exists`);
      }
      code = generateUniqueCode(body.name, 'CAMP');
    }

    const row = await this.databaseService.client.promoCampaign.create({
      data: {
        code,
        name: body.name,
        objective: body.objective ?? 'ACQUISITION',
        status: body.status ?? 'DRAFT',
        budget: body.budget ?? null,
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
        createdBy: createdBy ?? null,
      },
      include: this.includeTargets,
    });
    return this.toDto(row);
  }

  async update(id: string, body: UpdateCampaignBody): Promise<CampaignDto> {
    const existing = await this.databaseService.client.promoCampaign.findUnique({ where: { id } });
    if (!existing) throw new CampaignNotFoundError();

    if (body.code) {
      const code = body.code.trim().toUpperCase();
      const clash = await this.databaseService.client.promoCampaign.findFirst({
        where: { code, id: { not: id } },
      });
      if (clash) throw new CampaignConflictError(`Campaign code "${code}" already exists`);
    }

    const row = await this.databaseService.client.promoCampaign.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.objective !== undefined ? { objective: body.objective } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.budget !== undefined ? { budget: body.budget } : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt } : {}),
      },
      include: this.includeTargets,
    });
    return this.toDto(row);
  }

  async setTargets(id: string, body: SetCampaignTargetsBody): Promise<CampaignDto> {
    const campaign = await this.databaseService.client.promoCampaign.findUnique({ where: { id } });
    if (!campaign) throw new CampaignNotFoundError();

    for (const t of body.targets) {
      const segment = await this.databaseService.client.audienceSegment.findUnique({
        where: { id: t.segmentId },
      });
      if (!segment) throw new SegmentNotFoundError(`Segment ${t.segmentId} was not found`);
      if (t.promotionId) {
        const promo = await this.databaseService.client.promotion.findUnique({
          where: { id: t.promotionId },
        });
        if (!promo) throw new PromotionNotFoundError(`Promotion ${t.promotionId} was not found`);
      }
    }

    await this.databaseService.transactionManager.execute(async (tx) => {
      await tx.campaignTarget.deleteMany({ where: { campaignId: id } });
      if (body.targets.length) {
        await tx.campaignTarget.createMany({
          data: body.targets.map((t) => ({
            campaignId: id,
            segmentId: t.segmentId,
            promotionId: t.promotionId ?? null,
          })),
        });
      }
    });

    return this.getById(id);
  }
}
