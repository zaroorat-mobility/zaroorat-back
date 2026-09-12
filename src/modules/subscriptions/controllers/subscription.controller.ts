import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { actingDriverId } from '@modules/drivers/controllers/driver-identity.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { SubscriptionPlanRepository } from '../repositories/subscription-plan.repository.js';
import {
  purchaseSubscriptionSchema,
  createSubscriptionPlanSchema,
} from '../schemas/subscription.schemas.js';

export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly subscriptionPlanRepository: SubscriptionPlanRepository,
    private readonly driverRepository: DriverRepository,
  ) {}

  async listPlans(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const plans = await this.subscriptionService.listActivePlans();
    reply.send({
      data: plans.map((p) => ({
        id: p.id,
        name: p.name,
        billingPeriod: p.billingPeriod,
        price: p.price.toNumber(),
        currency: p.currency,
      })),
    });
  }

  async purchase(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const driverId = await actingDriverId(req, this.driverRepository);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = purchaseSubscriptionSchema.parse(req.body);
    const result = await this.subscriptionService.purchase(
      driverId,
      userId,
      body.planId,
      idempotencyKey ?? '',
    );
    reply.send({
      data: {
        subscriptionId: result.subscription?.id ?? null,
        status: result.subscription?.status ?? null,
        intentId: result.intentId,
      },
    });
  }

  async getStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const subscription = await this.subscriptionService.getStatus(driverId);
    reply.send({
      data: subscription
        ? {
            id: subscription.id,
            planId: subscription.planId,
            pendingPlanId: subscription.pendingPlanId,
            status: subscription.status,
            paymentStatus: subscription.paymentStatus,
            startDate: subscription.startDate,
            expiryDate: subscription.expiryDate,
            cancelRequested: subscription.cancelRequested,
          }
        : null,
    });
  }

  async cancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    await this.subscriptionService.cancel(driverId);
    reply.send({ data: { cancelled: true } });
  }

  // Admin — finance:execute (payment-management.routes.ts's own precedent).
  async createPlan(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createSubscriptionPlanSchema.parse(req.body);
    const plan = await this.subscriptionPlanRepository.create({
      name: body.name,
      billingPeriod: body.billingPeriod,
      price: new Decimal(body.price),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
    });
    reply.status(201).send({
      data: {
        id: plan.id,
        name: plan.name,
        billingPeriod: plan.billingPeriod,
        price: plan.price.toNumber(),
        currency: plan.currency,
      },
    });
  }
}
