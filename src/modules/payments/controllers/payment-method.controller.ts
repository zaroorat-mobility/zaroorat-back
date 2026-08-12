import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { PaymentMethodRepository } from '../repositories/payment-method.repository.js';
import type { PaymentMethodView } from '../schemas/payment.responses.js';

export class PaymentMethodController {
  constructor(private readonly paymentMethodRepo: PaymentMethodRepository) {}

  async listUserMethods(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const methods = await this.paymentMethodRepo.listByUser(userId);

    const views: PaymentMethodView[] = methods.map((m) => ({
      id: m.id,
      methodType: m.methodType,
      brand: m.brand,
      last4: m.last4,
      upiVpa: m.upiVpa,
      isDefault: m.isDefault,
    }));

    reply.send({ data: views });
  }
}
