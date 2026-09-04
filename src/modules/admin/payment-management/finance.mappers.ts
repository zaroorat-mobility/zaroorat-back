import type { Prisma } from '../../../generated/prisma/index.js';

export type TimelineEvent = {
  action: string;
  actor: string;
  timestamp: string;
  notes?: string;
};

export type PageMeta = {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalCount: number;
};

export function pageMeta(page: number, limit: number, totalCount: number): PageMeta {
  return {
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    pageSize: limit,
    totalCount,
  };
}

export function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return value.toNumber();
}

export function asTimeline(value: unknown): TimelineEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is TimelineEvent =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as TimelineEvent).action === 'string' &&
      typeof (e as TimelineEvent).actor === 'string' &&
      typeof (e as TimelineEvent).timestamp === 'string',
  );
}

export function appendTimeline(existing: unknown, event: TimelineEvent): Prisma.InputJsonValue {
  return [...asTimeline(existing), event] as unknown as Prisma.InputJsonValue;
}

export function displayName(
  profile?: { firstName?: string | null; lastName?: string | null } | null,
  fallback = 'Unknown',
): string {
  const parts = [profile?.firstName, profile?.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : fallback;
}

export function mapPaymentMethod(method?: string | null): string {
  const m = (method ?? '').toLowerCase();
  if (m.includes('upi')) return 'upi';
  if (m.includes('card')) return 'card';
  if (m.includes('wallet')) return 'wallet';
  if (m.includes('cash')) return 'cash';
  if (m.includes('net')) return 'card';
  return 'upi';
}

export function mapGateway(gateway?: string | null): string | undefined {
  if (!gateway) return undefined;
  const g = gateway.toLowerCase();
  if (g.includes('razor')) return 'razorpay';
  if (g.includes('cashfree')) return 'cashfree';
  if (g.includes('phone')) return 'phonepe';
  if (g.includes('paytm')) return 'paytm';
  return g;
}

export function mapTxnStatus(
  status: string,
  refundedAmount: number,
  capturedAmount: number,
): string {
  const s = status.toUpperCase();
  if (s === 'FAILED') return 'failed';
  if (s === 'PENDING' || s === 'CREATED' || s === 'INITIATED') return 'processing';
  if (s === 'REVERSED') return 'reversed';
  if (refundedAmount > 0) {
    if (refundedAmount >= capturedAmount - 0.001) return 'fully_refunded';
    return 'partially_refunded';
  }
  if (s === 'SUCCESS' || s === 'CAPTURED' || s === 'SUCCEEDED' || s === 'COMPLETED') {
    return 'captured';
  }
  return 'initiated';
}

export function mapTxnType(txnType: string): {
  type: string;
  source: string;
  entityType: string;
  direction: string;
} {
  const t = txnType.toUpperCase();
  if (t.includes('REFUND')) {
    return { type: 'refund', source: 'refund', entityType: 'refund', direction: 'debit' };
  }
  if (t.includes('SETTLE') || t.includes('PAYOUT')) {
    return {
      type: 'settlement',
      source: 'settlement',
      entityType: 'settlement',
      direction: 'debit',
    };
  }
  if (t.includes('PENALTY')) {
    return {
      type: 'penalty',
      source: 'penalty',
      entityType: 'adjustment',
      direction: 'debit',
    };
  }
  if (t.includes('BONUS') || t.includes('INCENTIVE')) {
    return { type: 'bonus', source: 'bonus', entityType: 'adjustment', direction: 'credit' };
  }
  if (t.includes('ADJUST')) {
    return {
      type: 'adjustment',
      source: 'manual_adjustment',
      entityType: 'adjustment',
      direction: 'credit',
    };
  }
  return { type: 'ride_payment', source: 'ride', entityType: 'ride', direction: 'credit' };
}

export function mapDocType(
  documentType: string,
): 'licence' | 'rc' | 'insurance' | 'permit' | 'kyc' | 'puc' | 'police_verification' | 'id_proof' {
  switch (documentType) {
    case 'DRIVING_LICENSE':
      return 'licence';
    case 'RC':
      return 'rc';
    case 'INSURANCE':
      return 'insurance';
    case 'PUC':
      return 'puc';
    case 'POLICE_VERIFICATION':
      return 'police_verification';
    case 'AADHAAR':
    case 'PAN':
      return 'id_proof';
    case 'PROFILE_PHOTO':
      return 'kyc';
    default:
      return 'id_proof';
  }
}

export function mapVerificationStatus(status: string): 'verified' | 'pending' | 'rejected' {
  if (status === 'VERIFIED') return 'verified';
  if (status === 'REJECTED') return 'rejected';
  return 'pending';
}

export function expiryStatus(
  expiresAt: Date | null | undefined,
  thresholdDays: number,
  now = new Date(),
): 'valid' | 'expiring_soon' | 'expired' {
  if (!expiresAt) return 'valid';
  const ms = expiresAt.getTime() - now.getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 0) return 'expired';
  if (days <= thresholdDays) return 'expiring_soon';
  return 'valid';
}

export function mapWalletTxnType(txnType: string): string {
  switch (txnType) {
    case 'RIDE_EARNING':
      return 'RIDE_EARNING';
    case 'BONUS':
      return 'BONUS';
    case 'INCENTIVE':
      return 'INCENTIVE';
    case 'PENALTY':
      return 'PENALTY';
    case 'WITHDRAWAL':
      return 'SETTLEMENT_PAYOUT';
    case 'REFUND':
      return 'REFUND_DEDUCTION';
    case 'ADJUSTMENT':
      return 'ADJUSTMENT';
    default:
      return 'ADJUSTMENT';
  }
}

export function mapSettlementDriverStatus(status: string): 'pending' | 'paid' {
  const s = status.toUpperCase();
  if (s === 'PAID' || s === 'COMPLETED') return 'paid';
  return 'pending';
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function actorLabel(name: string | undefined, fallback = 'Admin Operator'): string {
  return name?.trim() || fallback;
}
