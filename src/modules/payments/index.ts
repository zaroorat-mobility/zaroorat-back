import { asClass, asFunction, aliasTo, AwilixContainer } from 'awilix';
import { paymentConfig } from '@config';
import { PaymentMetrics } from './metrics/payment.metrics.js';
import {
  PaymentMethodRepository,
  WalletRepository,
  IntentRepository,
  LedgerRepository,
  SettlementRepository,
  PayoutRepository,
  RefundRepository,
  ChargebackRepository,
  WebhookRepository,
  IdempotencyRepository,
} from './repositories/index.js';
import {
  MockGatewayProvider,
  RazorpayGatewayProvider,
  StripeGatewayProvider,
  PaymentGatewayProvider,
  LedgerService,
  WalletService,
  IntentService,
  RefundService,
  SettlementService,
  PayoutService,
  WebhookService,
  PaymentService,
} from './services/index.js';
import {
  PaymentMethodController,
  WalletController,
  IntentController,
  PayoutController,
  RefundController,
  WebhookController,
  PaymentController,
} from './controllers/index.js';
import { SettlementJob, ReconciliationJob } from './jobs/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './jobs/index.js';
export * from './metrics/index.js';
export * from './plugins/index.js';
export * from './events/index.js';
export * from './errors/index.js';
export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export function registerPaymentsModule(container: AwilixContainer): void {
  container.register({
    paymentMetrics: asClass(PaymentMetrics).singleton(),
    paymentMethodRepository: asClass(PaymentMethodRepository).singleton(),
    walletRepository: asClass(WalletRepository).singleton(),
    intentRepository: asClass(IntentRepository).singleton(),
    ledgerRepository: asClass(LedgerRepository).singleton(),
    settlementRepository: asClass(SettlementRepository).singleton(),
    payoutRepository: asClass(PayoutRepository).singleton(),
    refundRepository: asClass(RefundRepository).singleton(),
    chargebackRepository: asClass(ChargebackRepository).singleton(),
    webhookRepository: asClass(WebhookRepository).singleton(),
    idempotencyRepository: asClass(IdempotencyRepository).singleton(),
    paymentGatewayProvider: asFunction((): PaymentGatewayProvider => {
      const mode = paymentConfig.defaultGateway;
      if (mode === 'razorpay') {
        return new RazorpayGatewayProvider(
          paymentConfig.razorpayKeyId,
          paymentConfig.razorpayKeySecret,
        );
      }
      if (mode === 'stripe') {
        return new StripeGatewayProvider(paymentConfig.stripeSecretKey);
      }
      return new MockGatewayProvider();
    }).singleton(),
    ledgerService: asClass(LedgerService).singleton(),
    walletService: asClass(WalletService).singleton(),
    intentService: asClass(IntentService).singleton(),
    refundService: asClass(RefundService).singleton(),
    settlementService: asClass(SettlementService).singleton(),
    payoutService: asClass(PayoutService).singleton(),
    webhookService: asClass(WebhookService).singleton(),
    paymentService: asClass(PaymentService)
      .singleton()
      .inject((c) => ({
        wallet: c.resolve('walletService'),
        intent: c.resolve('intentService'),
        refund: c.resolve('refundService'),
        payout: c.resolve('payoutService'),
        settlement: c.resolve('settlementService'),
        webhook: c.resolve('webhookService'),
        idempotencyRepo: c.resolve('idempotencyRepository'),
      })),
    paymentMethodController: asClass(PaymentMethodController).singleton(),
    walletController: asClass(WalletController).singleton(),
    intentController: asClass(IntentController).singleton(),
    payoutController: asClass(PayoutController).singleton(),
    refundController: asClass(RefundController).singleton(),
    webhookController: asClass(WebhookController).singleton(),
    paymentController: asClass(PaymentController)
      .singleton()
      .inject((c) => ({
        paymentMethod: c.resolve('paymentMethodController'),
        wallet: c.resolve('walletController'),
        intent: c.resolve('intentController'),
        payout: c.resolve('payoutController'),
        refund: c.resolve('refundController'),
        webhook: c.resolve('webhookController'),
      })),
    settlementJob: asClass(SettlementJob).singleton(),
    reconciliationJob: asClass(ReconciliationJob).singleton(),
    gateway: aliasTo('paymentGatewayProvider'),
    intentRepo: aliasTo('intentRepository'),
    ledgerRepo: aliasTo('ledgerRepository'),
    webhookRepo: aliasTo('webhookRepository'),
    refundRepo: aliasTo('refundRepository'),
    payoutRepo: aliasTo('payoutRepository'),
    settlementRepo: aliasTo('settlementRepository'),
    paymentMethodRepo: aliasTo('paymentMethodRepository'),
    idempotencyRepo: aliasTo('idempotencyRepository'),
    txManager: aliasTo('transactionManager'),
  });
}
