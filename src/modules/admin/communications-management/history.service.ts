import { DatabaseService } from '@core/database';
import type {
  NotificationChannel,
  NotificationStatus,
  Prisma,
} from '../../../generated/prisma/index.js';
import type { DeliveryHistoryQuery } from './communications.schemas.js';

export interface DeliveryHistoryDto {
  id: string;
  channel: NotificationChannel;
  templateId: string | null;
  recipient: string | null;
  status: NotificationStatus;
  failureReason: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function toDeliveryDto(row: {
  id: string;
  channel: NotificationChannel;
  templateId: string | null;
  recipient: string | null;
  status: NotificationStatus;
  failureReason: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
}): DeliveryHistoryDto {
  return {
    id: row.id,
    channel: row.channel,
    templateId: row.templateId,
    recipient: row.recipient,
    status: row.status,
    failureReason: row.failureReason ?? row.errorMessage,
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    openedAt: row.openedAt?.toISOString() ?? null,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AdminCommunicationsHistoryService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get client() {
    return this.databaseService.client;
  }

  async listDeliveries(query: DeliveryHistoryQuery): Promise<{
    data: DeliveryHistoryDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.NotificationDeliveryWhereInput = {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [rows, totalCount] = await Promise.all([
      this.client.notificationDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.client.notificationDelivery.count({ where }),
    ]);

    return {
      data: rows.map(toDeliveryDto),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }
}
