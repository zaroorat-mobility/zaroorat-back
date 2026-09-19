export interface WalletView {
  /// Null when the customer has no (historical) wallet row.
  id: string | null;
  userId: string;
  balance: number;
  lockedBalance: number;
  availableBalance: number;
  currency: string;
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
