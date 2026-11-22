export interface CallInitiationResult {
  provider: 'direct' | 'exotel';
  /// For `direct`, the counterparty E.164 number. For Exotel, a virtual bridge number or null.
  dialNumber: string | null;
  masked: boolean;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CallContext {
  rideId: string;
  callerUserId: string;
  callerRole: 'CUSTOMER' | 'DRIVER';
  counterpartyUserId: string;
  counterpartyPhone: string;
}

export interface CallProvider {
  readonly name: 'direct' | 'exotel';
  initiate(ctx: CallContext): Promise<CallInitiationResult>;
}

/// Returns the counterparty's real phone. Acceptable for early environments;
/// production should prefer a masked provider (Exotel).
export class DirectCallProvider implements CallProvider {
  readonly name = 'direct' as const;
  async initiate(ctx: CallContext): Promise<CallInitiationResult> {
    return {
      provider: 'direct',
      dialNumber: ctx.counterpartyPhone,
      masked: false,
    };
  }
}

/// Stub Exotel adapter. Wire real Exotel credentials when CALL_PROVIDER=exotel
/// is enabled in production; until then it returns a placeholder bridge number.
export class ExotelCallProvider implements CallProvider {
  readonly name = 'exotel' as const;
  async initiate(ctx: CallContext): Promise<CallInitiationResult> {
    const bridge = process.env.EXOTEL_VIRTUAL_NUMBER ?? null;
    return {
      provider: 'exotel',
      dialNumber: bridge,
      masked: true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      metadata: {
        stub: true,
        rideId: ctx.rideId,
        note: 'Exotel integration is stubbed — configure EXOTEL_* credentials to enable masked calling',
      },
    };
  }
}

export type CallProviderName = 'direct' | 'exotel';

export function resolveCallProviderName(explicit?: string): CallProviderName {
  const selected = (explicit ?? process.env.CALL_PROVIDER ?? 'direct').toLowerCase();
  if (selected === 'exotel') return 'exotel';
  return 'direct';
}

export function createCallProvider(): CallProvider {
  return resolveCallProviderName() === 'exotel'
    ? new ExotelCallProvider()
    : new DirectCallProvider();
}
