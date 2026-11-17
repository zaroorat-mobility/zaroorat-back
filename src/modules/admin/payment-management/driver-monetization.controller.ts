import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminDriverMonetizationService } from './driver-monetization.service.js';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const walletsQuery = pageQuery.extend({ search: z.string().trim().max(80).optional() });
const subscriptionsQuery = pageQuery.extend({
  status: z.enum(['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED']).optional(),
});
const driverParams = z.object({ driverId: z.string().uuid() });
const transactionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/// finance:read only. These routes never move money.
export class AdminDriverMonetizationController {
  constructor(private readonly adminDriverMonetizationService: AdminDriverMonetizationService) {}

  async listCommissionWallets(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(
      await this.adminDriverMonetizationService.listCommissionWallets(
        walletsQuery.parse(req.query),
      ),
    );
  }

  async listCommissionWalletTransactions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId } = driverParams.parse(req.params);
    const { limit } = transactionsQuery.parse(req.query);
    reply.send({
      data: await this.adminDriverMonetizationService.listCommissionWalletTransactions(
        driverId,
        limit,
      ),
    });
  }

  async listSubscriptionPlans(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send({ data: await this.adminDriverMonetizationService.listSubscriptionPlans() });
  }

  async listDriverSubscriptions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(
      await this.adminDriverMonetizationService.listDriverSubscriptions(
        subscriptionsQuery.parse(req.query),
      ),
    );
  }
}
