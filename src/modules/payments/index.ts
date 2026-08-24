import { asClass, asFunction, aliasTo, AwilixContainer } from 'awilix';
import { paymentConfig } from '@config';
import { PaymentMetrics } from './metrics/payment.metrics.js';
import {
  PaymentMethodRepository,
  WalletRepository,
  IntentRepository,
  LedgerRepository,
  SettlementRepository,
  SettlementWalletRepository,
  PayoutRepository,
  RefundRepository,
  ChargebackRepository,
  WebhookRepository,
  IdempotencyRepository,
  RidePaymentRepository,
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
  RideCollectionService,
  DebtService,
  WriteOffService,
} from './services/index.js';
import {
  PaymentMethodController,
  WalletController,
  IntentController,
  PayoutController,
  RefundController,
  WebhookController,
  PaymentController,
  RidePaymentController,
} from './controllers/index.js';
import {
  SettlementJob,
  ReconciliationJob,
  CollectionSweepJob,
  ReceivableWriteOffJob,
} from './jobs/index.js';
import { RideCollectionConsumer } from './consumers/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './jobs/index.js';
export * from './metrics/index.js';
export * from './plugins/index.js';
export * from './consumers/index.js';
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
    settlementWalletRepository: asClass(SettlementWalletRepository).singleton(),
    payoutRepository: asClass(PayoutRepository).singleton(),
    refundRepository: asClass(RefundRepository).singleton(),
    chargebackRepository: asClass(ChargebackRepository).singleton(),
    webhookRepository: asClass(WebhookRepository).singleton(),
    idempotencyRepository: asClass(IdempotencyRepository).singleton(),
    ridePaymentRepository: asClass(RidePaymentRepository).singleton(),
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
    rideCollectionService: asClass(RideCollectionService).singleton(),
    debtService: asClass(DebtService).singleton(),
    writeOffService: asClass(WriteOffService).singleton(),
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
    ridePaymentController: asClass(RidePaymentController).singleton(),
    paymentController: asClass(PaymentController)
      .singleton()
      .inject((c) => ({
        paymentMethod: c.resolve('paymentMethodController'),
        wallet: c.resolve('walletController'),
        intent: c.resolve('intentController'),
        payout: c.resolve('payoutController'),
        refund: c.resolve('refundController'),
        webhook: c.resolve('webhookController'),
        ridePayment: c.resolve('ridePaymentController'),
      })),
    rideCollectionConsumer: asClass(RideCollectionConsumer).singleton(),
    settlementJob: asClass(SettlementJob).singleton(),
    collectionSweepJob: asClass(CollectionSweepJob).singleton(),
    receivableWriteOffJob: asClass(ReceivableWriteOffJob).singleton(),
    reconciliationJob: asClass(ReconciliationJob).singleton(),
    gateway: aliasTo('paymentGatewayProvider'),
    intentRepo: aliasTo('intentRepository'),
    ledgerRepo: aliasTo('ledgerRepository'),
    webhookRepo: aliasTo('webhookRepository'),
    refundRepo: aliasTo('refundRepository'),
    payoutRepo: aliasTo('payoutRepository'),
    settlementRepo: aliasTo('settlementRepository'),
    settlementWalletRepo: aliasTo('settlementWalletRepository'),
    paymentMethodRepo: aliasTo('paymentMethodRepository'),
    idempotencyRepo: aliasTo('idempotencyRepository'),
    ridePaymentRepo: aliasTo('ridePaymentRepository'),
    txManager: aliasTo('transactionManager'),
  });
}
