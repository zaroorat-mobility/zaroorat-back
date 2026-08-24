import { PaymentMethodController } from './payment-method.controller.js';
import { WalletController } from './wallet.controller.js';
import { IntentController } from './intent.controller.js';
import { PayoutController } from './payout.controller.js';
import { RefundController } from './refund.controller.js';
import { RidePaymentController } from './ride-payment.controller.js';
import { WebhookController } from './webhook.controller.js';
export class PaymentController {
  constructor(
    public readonly paymentMethod: PaymentMethodController,
    public readonly wallet: WalletController,
    public readonly intent: IntentController,
    public readonly payout: PayoutController,
    public readonly refund: RefundController,
    public readonly webhook: WebhookController,
    public readonly ridePayment: RidePaymentController,
  ) {}
}
