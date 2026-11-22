import { DatabaseService } from '@core/database';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager.js';
import { FileLifecycleService } from '@modules/files/services/file-lifecycle.service.js';
import { Prisma } from '../../../../generated/prisma/index.js';
import { lockForAudit, recordAdminAction, type AuditActor } from '../../audit/index.js';
import { BannerNotFoundError, CampaignNotFoundError } from '../promotions.errors.js';
import type { CreateBannerBody, ListBannersQuery, UpdateBannerBody } from '../schemas.js';

export interface BannerDto {
  id: string;
  campaignId: string | null;
  title: string | null;
  imageFileId: string;
  placement: string;
  actionUrl: string | null;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  status: 'active' | 'inactive';
  createdAt: string;
}

export class AdminBannerService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly transactionManager: TransactionManager,
    private readonly fileLifecycleService: FileLifecycleService,
  ) {}

  async isBannerImage(fileId: string, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.databaseService.client;
    const count = await client.promoBanner.count({ where: { imageFileId: fileId } });
    return count > 0;
  }

  private toDto(row: {
    id: string;
    campaignId: string | null;
    title: string | null;
    imageFileId: string;
    placement: string;
    actionUrl: string | null;
    priority: number;
    startsAt: Date | null;
    endsAt: Date | null;
    isActive: boolean;
    createdAt: Date;
  }): BannerDto {
    return {
      id: row.id,
      campaignId: row.campaignId,
      title: row.title,
      imageFileId: row.imageFileId,
      placement: row.placement,
      actionUrl: row.actionUrl,
      priority: row.priority,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      isActive: row.isActive,
      status: row.isActive ? 'active' : 'inactive',
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(query: ListBannersQuery): Promise<{
    data: BannerDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.PromoBannerWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.search) {
      where.title = { contains: query.search, mode: 'insensitive' };
    }

    const totalCount = await this.databaseService.client.promoBanner.count({ where });
    const rows = await this.databaseService.client.promoBanner.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
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

  async getById(id: string): Promise<BannerDto> {
    const row = await this.databaseService.client.promoBanner.findUnique({ where: { id } });
    if (!row) throw new BannerNotFoundError();
    return this.toDto(row);
  }

  /// The uploader the image must belong to is the authenticated staff member — the
  /// same `actorId` the audit row records.
  async create(body: CreateBannerBody, actor: AuditActor): Promise<BannerDto> {
    if (body.campaignId) {
      const campaign = await this.databaseService.client.promoCampaign.findUnique({
        where: { id: body.campaignId },
      });
      if (!campaign) throw new CampaignNotFoundError();
    }

    return this.transactionManager.execute(async (tx) => {
      await this.fileLifecycleService.assertReferenceable(
        body.imageFileId,
        actor.actorId,
        'PROMO_BANNER',
        tx,
      );

      const row = await tx.promoBanner.create({
        data: {
          campaignId: body.campaignId ?? null,
          title: body.title ?? null,
          imageFileId: body.imageFileId,
          placement: body.placement ?? 'HOME',
          actionUrl: body.actionUrl ?? null,
          priority: body.priority ?? 0,
          startsAt: body.startsAt ?? null,
          endsAt: body.endsAt ?? null,
          isActive: body.isActive ?? true,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'promo_banner',
        entityId: row.id,
        summary: `Banner ${row.title ?? row.id} created`,
        after: row,
        result: 'SUCCESS',
      });
      return this.toDto(row);
    });
  }

  async update(id: string, body: UpdateBannerBody, actor: AuditActor): Promise<BannerDto> {
    return this.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'promo_banners', id);
      const existing = await tx.promoBanner.findUnique({ where: { id } });
      if (!existing) throw new BannerNotFoundError();
      if (body.campaignId) {
        const campaign = await tx.promoCampaign.findUnique({ where: { id: body.campaignId } });
        if (!campaign) throw new CampaignNotFoundError();
      }

      if (body.imageFileId !== undefined && body.imageFileId !== existing.imageFileId) {
        await this.fileLifecycleService.assertReferenceable(
          body.imageFileId,
          actor.actorId,
          'PROMO_BANNER',
          tx,
        );
        await this.fileLifecycleService.supersede(existing.imageFileId, body.imageFileId, tx);
      }

      const row = await tx.promoBanner.update({
        where: { id },
        data: {
          ...(body.campaignId !== undefined ? { campaignId: body.campaignId } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.imageFileId !== undefined ? { imageFileId: body.imageFileId } : {}),
          ...(body.placement !== undefined ? { placement: body.placement } : {}),
          ...(body.actionUrl !== undefined ? { actionUrl: body.actionUrl } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.startsAt !== undefined ? { startsAt: body.startsAt } : {}),
          ...(body.endsAt !== undefined ? { endsAt: body.endsAt } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'promo_banner',
        entityId: id,
        summary: `Banner ${row.title ?? row.id} updated`,
        before: existing,
        after: row,
        result: 'SUCCESS',
      });
      return this.toDto(row);
    });
  }

  async activate(id: string, actor: AuditActor): Promise<BannerDto> {
    return this.update(id, { isActive: true }, actor);
  }

  async deactivate(id: string, actor: AuditActor): Promise<BannerDto> {
    return this.update(id, { isActive: false }, actor);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await this.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'promo_banners', id);
      const existing = await tx.promoBanner.findUnique({ where: { id } });
      if (!existing) throw new BannerNotFoundError();
      await tx.promoBanner.delete({ where: { id } });
      await recordAdminAction(tx, {
        ...actor,
        action: 'DELETE',
        entityType: 'promo_banner',
        entityId: id,
        summary: `Banner ${existing.title ?? existing.id} deleted`,
        before: existing,
        result: 'SUCCESS',
      });
    });
  }
}
