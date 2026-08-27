import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { generateUniqueCode } from './code.util.js';
import { SegmentConflictError, SegmentNotFoundError } from './promotions.errors.js';
import type { CreateSegmentBody, ListSegmentsQuery, UpdateSegmentBody } from './schemas.js';

export interface SegmentDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rules: unknown;
  estimatedSize: number | null;
  isDynamic: boolean;
  createdAt: string;
  updatedAt: string;
}

export class AdminSegmentService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toDto(row: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    rules: Prisma.JsonValue;
    estimatedSize: number | null;
    isDynamic: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): SegmentDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      rules: row.rules,
      estimatedSize: row.estimatedSize,
      isDynamic: row.isDynamic,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(query: ListSegmentsQuery): Promise<{
    data: SegmentDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.AudienceSegmentWhereInput = {};
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const totalCount = await this.databaseService.client.audienceSegment.count({ where });
    const rows = await this.databaseService.client.audienceSegment.findMany({
      where,
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

  async getById(id: string): Promise<SegmentDto> {
    const row = await this.databaseService.client.audienceSegment.findUnique({ where: { id } });
    if (!row) throw new SegmentNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateSegmentBody): Promise<SegmentDto> {
    let code = body.code?.trim().toUpperCase();
    if (!code) {
      code = generateUniqueCode(body.name, 'SEG');
    }
    const existing = await this.databaseService.client.audienceSegment.findUnique({
      where: { code },
    });
    if (existing) {
      if (body.code) {
        throw new SegmentConflictError(`Segment code "${code}" already exists`);
      }
      code = generateUniqueCode(body.name, 'SEG');
    }

    const row = await this.databaseService.client.audienceSegment.create({
      data: {
        code,
        name: body.name,
        description: body.description ?? null,
        rules: body.rules ?? Prisma.JsonNull,
        estimatedSize: body.estimatedSize ?? null,
        isDynamic: body.isDynamic ?? true,
      },
    });
    return this.toDto(row);
  }

  async update(id: string, body: UpdateSegmentBody): Promise<SegmentDto> {
    const existing = await this.databaseService.client.audienceSegment.findUnique({
      where: { id },
    });
    if (!existing) throw new SegmentNotFoundError();

    if (body.code) {
      const code = body.code.trim().toUpperCase();
      const clash = await this.databaseService.client.audienceSegment.findFirst({
        where: { code, id: { not: id } },
      });
      if (clash) throw new SegmentConflictError(`Segment code "${code}" already exists`);
    }

    const row = await this.databaseService.client.audienceSegment.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.rules !== undefined
          ? { rules: body.rules === null ? Prisma.JsonNull : body.rules }
          : {}),
        ...(body.estimatedSize !== undefined ? { estimatedSize: body.estimatedSize } : {}),
        ...(body.isDynamic !== undefined ? { isDynamic: body.isDynamic } : {}),
      },
    });
    return this.toDto(row);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.databaseService.client.audienceSegment.findUnique({
      where: { id },
    });
    if (!existing) throw new SegmentNotFoundError();

    await this.databaseService.transactionManager.execute(async (tx) => {
      await tx.campaignTarget.deleteMany({ where: { segmentId: id } });
      await tx.audienceSegment.delete({ where: { id } });
    });
  }
}
