export interface WalletView {
  id: string;
  userId: string;
  balance: number;
  lockedBalance: number;
  availableBalance: number;
  currency: string;
}
/// The top-up response. Every `WalletView` field is still present and still
/// means the same thing — `balance` is simply the balance as it stands, which
/// is now the *uncredited* one, because a top-up no longer moves money by
/// itself. The intent fields tell the client what to take to the gateway.
export interface WalletTopupView extends WalletView {
  intentId: string;
  intentStatus: string;
  gateway: string | null;
  gatewayIntentId: string | null;
  amount: number;
}
export interface IntentView {
  id: string;
  userId: string;
  rideId: string | null;
  amount: number;
  currency: string;
  status: string;
  gateway: string | null;
  gatewayIntentId: string | null;
  createdAt: Date;
}
export interface PaymentMethodView {
  id: string;
  methodType: string;
  brand: string | null;
  last4: string | null;
  upiVpa: string | null;
  isDefault: boolean;
}
