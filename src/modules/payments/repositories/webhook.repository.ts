import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma';
import type { GatewayEvent } from '../types';

export class WebhookRepository {
  constructor(private readonly db: DatabaseService) {}

  async findOrPersist(
    data: {
      gateway: string;
      eventType: string;
      gatewayEventId: string;
      payload: Prisma.InputJsonValue;
      signature?: string | null;
    },
    tx?: TransactionClient,
  ): Promise<{ event: GatewayEvent; isDuplicate: boolean }> {
    const client = tx ?? this.db.client;

    const existing = await client.gatewayEvent.findUnique({
      where: {
        gateway_gatewayEventId: {
          gateway: data.gateway,
          gatewayEventId: data.gatewayEventId,
        },
      },
    });

    if (existing) {
      return { event: existing, isDuplicate: true };
    }

    const created = await client.gatewayEvent.create({
      data: {
        gateway: data.gateway,
        eventType: data.eventType,
        gatewayEventId: data.gatewayEventId,
        payload: data.payload,
        signature: data.signature ?? null,
        processed: false,
      },
    });

    return { event: created, isDuplicate: false };
  }

  async markProcessed(id: string, tx?: TransactionClient): Promise<GatewayEvent> {
    const client = tx ?? this.db.client;
    return client.gatewayEvent.update({
      where: { id },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });
  }
}
