import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { PaymentInstrument } from '../types';
export interface CreatePaymentMethodInput {
  userId: string;
  methodType: string;
  gateway?: string;
  gatewayToken?: string;
  brand?: string;
  last4?: string;
  upiVpa?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault?: boolean;
}
export class PaymentMethodRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(
    input: CreatePaymentMethodInput,
    tx?: TransactionClient,
  ): Promise<PaymentInstrument> {
    const client = tx ?? this.db.client;
    if (input.isDefault) {
      await client.paymentInstrument.updateMany({
        where: { userId: input.userId },
        data: { isDefault: false },
      });
    }
    return client.paymentInstrument.create({
      data: {
        userId: input.userId,
        methodType: input.methodType,
        isDefault: input.isDefault ?? false,
        ...(input.gateway !== undefined ? { gateway: input.gateway } : {}),
        ...(input.gatewayToken !== undefined ? { gatewayToken: input.gatewayToken } : {}),
        ...(input.brand !== undefined ? { brand: input.brand } : {}),
        ...(input.last4 !== undefined ? { last4: input.last4 } : {}),
        ...(input.upiVpa !== undefined ? { upiVpa: input.upiVpa } : {}),
        ...(input.expiryMonth !== undefined ? { expiryMonth: input.expiryMonth } : {}),
        ...(input.expiryYear !== undefined ? { expiryYear: input.expiryYear } : {}),
      },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<PaymentInstrument | null> {
    const client = tx ?? this.db.client;
    return client.paymentInstrument.findUnique({
      where: { id, isActive: true },
    });
  }
  async listByUser(userId: string, tx?: TransactionClient): Promise<PaymentInstrument[]> {
    const client = tx ?? this.db.client;
    return client.paymentInstrument.findMany({
      where: { userId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }
}
