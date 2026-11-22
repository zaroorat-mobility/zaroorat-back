import { DatabaseService } from '@core/database';

export interface AuditLogDto {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}

export class AdminAuditService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async listLogs(input: {
    page: number;
    limit: number;
    actorId?: string | undefined;
    entityType?: string | undefined;
    entityTypes?: string[] | undefined;
    entityId?: string | undefined;
    action?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    search?: string | undefined;
  }): Promise<{ data: AuditLogDto[]; meta: { page: number; limit: number; total: number } }> {
    const createdAtFilter: { gte?: Date; lte?: Date } = {};
    if (input.from) createdAtFilter.gte = new Date(input.from);
    if (input.to) createdAtFilter.lte = new Date(input.to);

    const where: Record<string, unknown> = {
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.entityTypes && input.entityTypes.length > 0
        ? { entityType: { in: input.entityTypes } }
        : input.entityType
          ? { entityType: input.entityType }
          : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.action ? { action: input.action as never } : {}),
      ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
      ...(input.search
        ? {
            OR: [
              { summary: { contains: input.search, mode: 'insensitive' } },
              { entityType: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.client.adminActivityLog.findMany({
        where,
        include: {
          actor: {
            select: { phoneNumber: true, profile: { select: { firstName: true, lastName: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.client.adminActivityLog.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorName: row.actor
          ? [row.actor.profile?.firstName, row.actor.profile?.lastName].filter(Boolean).join(' ') ||
            row.actor.phoneNumber
          : null,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { page: input.page, limit: input.limit, total },
    };
  }
}
