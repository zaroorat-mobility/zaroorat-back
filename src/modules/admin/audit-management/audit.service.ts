import { DatabaseService } from '@core/database';

export interface AuditLogDto {
  id: string;
  actorId: string | null;
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
    entityId?: string | undefined;
    action?: string | undefined;
  }): Promise<{ data: AuditLogDto[]; meta: { page: number; limit: number; total: number } }> {
    const where = {
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.action ? { action: input.action as never } : {}),
    };

    const [rows, total] = await Promise.all([
      this.client.adminActivityLog.findMany({
        where,
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
