import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { auditActor } from '@modules/admin/audit/index.js';
import { Decimal } from '../types/index.js';
import { actingDriverId } from '@modules/drivers/controllers/driver-identity.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { PaymentService } from '@modules/payments/services/payment.service.js';
import {
  purchaseSubscriptionSchema,
  createSubscriptionPlanSchema,
} from '../schemas/subscription.schemas.js';

export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly driverRepository: DriverRepository,
    private readonly paymentService: PaymentService,
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
    // Required, never defaulted: a missing key used to become '' — one global
    // key shared by every purchase that omitted the header. The wrapper refuses
    // a missing/blank key (400) and replays the first response for a retry of
    // the same driver's same request, so a retry creates no second
    // subscription row and no second intent.
    const data = await this.paymentService.withIdempotency(
      userId,
      '/subscriptions',
      idempotencyKey,
      body,
      async () => {
        const result = await this.subscriptionService.purchase(
          driverId,
          userId,
          body.planId,
          idempotencyKey as string,
        );
        return {
          subscriptionId: result.subscription?.id ?? null,
          status: result.subscription?.status ?? null,
          intentId: result.intentId,
        };
      },
    );
    reply.send({ data });
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

  async listInvoices(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const data = await this.subscriptionService.listInvoices(driverId);
    reply.send({ data });
  }

  // Admin — finance:execute (payment-management.routes.ts's own precedent).
  /// An Idempotency-Key is honoured when sent: a retried or double-submitted create returns
  /// the first plan instead of a second one (and writes no second audit row). Without one,
  /// each request creates a plan, as before.
  async createPlan(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createSubscriptionPlanSchema.parse(req.body);
    const actor = auditActor(req);
    const create = async () => {
      const plan = await this.subscriptionService.createPlan(
        {
          name: body.name,
          billingPeriod: body.billingPeriod,
          price: new Decimal(body.price),
          ...(body.currency !== undefined ? { currency: body.currency } : {}),
        },
        actor,
      );
      return {
        id: plan.id,
        name: plan.name,
        billingPeriod: plan.billingPeriod,
        price: plan.price.toNumber(),
        currency: plan.currency,
      };
    };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const data = idempotencyKey
      ? await this.paymentService.withIdempotency(
          actor.actorId,
          '/subscriptions/plans',
          idempotencyKey,
          body,
          create,
        )
      : await create();
    reply.status(201).send({ data });
  }
}
