import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { paymentConfig } from '@config';
import { PaymentService } from '../services/payment.service.js';
import { WalletRechargeOptionRepository } from '../repositories/wallet-recharge-option.repository.js';
import { rechargeCommissionWalletSchema } from '../schemas/payment.schemas.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import {
  CommissionRechargeNotAllowedError,
  InvalidRechargeAmountError,
  RechargeOptionNotFoundError,
} from '../errors/payment.errors.js';

/// spec.md FR-008/FR-008a/FR-008b — wallet recharge is a POST here (payments
/// module owns the write, mirroring SettlementWalletRepository's split for
/// DriverWallet). Balance/history GET routes live in the drivers module —
/// see DriverCommissionWalletController — the same read/write split already
/// established for the driver earnings wallet.
export class CommissionWalletController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly rechargeOptionRepository: WalletRechargeOptionRepository,
    private readonly driverRepository: DriverRepository,
  ) {}

  async recharge(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    // Before the idempotency record and before any intent: a caller who may
    // not buy commission credit gets nothing created, and never reaches a
    // gateway. Previously any authenticated user could pay here; the webhook
    // then threw "no driver profile" — money captured, never credited.
    const driverId = await this.assertMayRecharge(userId);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = rechargeCommissionWalletSchema.parse(req.body);
    const result = await this.paymentService.withIdempotency(
      userId,
      '/payments/driver-wallet/recharge',
      idempotencyKey,
      body,
      async () => {
        let amount: number;
        if (body.rechargeOptionId != null) {
          const option = await this.rechargeOptionRepository.findById(body.rechargeOptionId);
          if (!option || option.status !== 'ACTIVE') {
            throw new RechargeOptionNotFoundError();
          }
          amount = option.amount.toNumber();
        } else {
          amount = body.amount as number;
          if (
            amount < paymentConfig.commissionWalletMinRecharge ||
            amount > paymentConfig.commissionWalletMaxRecharge
          ) {
            throw new InvalidRechargeAmountError(
              `Amount must be between ${paymentConfig.commissionWalletMinRecharge} and ${paymentConfig.commissionWalletMaxRecharge}`,
            );
          }
        }
        // Never credited by this call itself — only PaymentIntent creation
        // happens here. The wallet moves exclusively inside
        // IntentService.applyConfirmation, on provider confirmation
        // (spec.md FR-009).
        const intent = await this.paymentService.intent.createIntent({
          userId,
          amount: new Decimal(amount),
          methodType: 'CARD',
          // `payment_intents.idempotency_key` is unique across ALL users, so the
          // client's key is scoped to this driver, as subscriptions already do —
          // two drivers sending the same key get two separate intents.
          idempotencyKey: `recharge:${driverId}:${idempotencyKey as string}`,
          purpose: 'DRIVER_COMMISSION_RECHARGE',
        });
        return {
          intentId: intent.id,
          intentStatus: intent.status,
          gateway: intent.gateway,
          gatewayIntentId: intent.gatewayIntentId,
          amount: intent.amount.toNumber(),
        };
      },
    );
    // 005 T042: what the app's native checkout opens with; null when the
    // provider has none (the mock in development). Built on every answer, a
    // replay included: inside the replayed record it froze the values of the
    // first answer, such as a phone number added later (UD-9) or a rotated key.
    const intent = await this.paymentService.intent.findById(result.intentId);
    reply.send({
      data: {
        ...result,
        checkout: intent
          ? await this.paymentService.intent.checkoutFor(intent, 'Commission wallet recharge')
          : null,
      },
    });
  }

  /// Commission credit only pays platform commission, so only a COMMISSION
  /// driver may buy it — or a SUBSCRIPTION driver whose switch to COMMISSION is
  /// already staged (BD-5, `pendingPaymentModel`), who needs credit ready for
  /// the moment the paid period ends.
  private async assertMayRecharge(userId: string): Promise<string> {
    const driver = await this.driverRepository.findByUserId(userId);
    if (
      driver == null ||
      (driver.paymentModel !== 'COMMISSION' && driver.pendingPaymentModel !== 'COMMISSION')
    ) {
      throw new CommissionRechargeNotAllowedError();
    }
    return driver.id;
  }

  async listRechargeOptions(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const options = await this.rechargeOptionRepository.listActive();
    reply.send({
      data: options.map((o) => ({
        id: o.id,
        amount: o.amount.toNumber(),
        label: o.label,
        sortOrder: o.sortOrder,
      })),
    });
  }
}
