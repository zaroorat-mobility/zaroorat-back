export interface RideRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  perWaitingMinute: number;
  platformFee: number;
  commissionRate: number;
  taxRate: number;
  minimumFare: number;
}

export interface RideConfig {
  defaultSearchRadiusKm: number;
  dispatchTimeoutSeconds: number;
  requestExpiryMinutes: number;
  requireStartOtp: boolean;
  cancellationGraceMinutes: number;
  defaultCancellationFee: number;
  defaultRateCard: RideRateCard;
  rateCardsByVehicleType: Readonly<Record<string, RideRateCard>>;
}

const defaultRateCard: RideRateCard = Object.freeze({
  baseFare: Number(process.env.RIDE_BASE_FARE ?? 50),
  perKm: Number(process.env.RIDE_RATE_PER_KM ?? 12),
  perMinute: Number(process.env.RIDE_RATE_PER_MIN ?? 2),
  perWaitingMinute: Number(process.env.RIDE_RATE_PER_WAIT_MIN ?? 3),
  platformFee: Number(process.env.RIDE_PLATFORM_FEE ?? 15),
  commissionRate: Number(process.env.RIDE_COMMISSION_RATE ?? 0.2),
  taxRate: Number(process.env.RIDE_TAX_RATE ?? 0.05),
  minimumFare: Number(process.env.RIDE_MINIMUM_FARE ?? 50),
});

function parseRateCards(): Readonly<Record<string, RideRateCard>> {
  const raw = process.env.RIDE_RATE_CARDS_JSON;
  if (raw == null || raw.trim() === '') return Object.freeze({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RIDE_RATE_CARDS_JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('RIDE_RATE_CARDS_JSON must be a JSON object keyed by vehicle type');
  }

  const cards: Record<string, RideRateCard> = {};
  for (const [vehicleType, override] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof override !== 'object' || override === null) {
      throw new Error(`RIDE_RATE_CARDS_JSON["${vehicleType}"] must be an object`);
    }
    cards[vehicleType] = Object.freeze({
      ...defaultRateCard,
      ...(override as Partial<RideRateCard>),
    });
  }
  return Object.freeze(cards);
}

export const rideConfig: RideConfig = Object.freeze({
  defaultSearchRadiusKm: Number(process.env.RIDE_SEARCH_RADIUS_KM ?? 5),
  dispatchTimeoutSeconds: Number(process.env.RIDE_DISPATCH_TIMEOUT_SEC ?? 30),
  requestExpiryMinutes: Number(process.env.RIDE_REQUEST_EXPIRY_MIN ?? 5),
  requireStartOtp: process.env.RIDE_REQUIRE_START_OTP !== 'false',
  cancellationGraceMinutes: Number(process.env.RIDE_CANCELLATION_GRACE_MIN ?? 2),
  defaultCancellationFee: Number(process.env.RIDE_DEFAULT_CANCELLATION_FEE ?? 50),
  defaultRateCard,
  rateCardsByVehicleType: parseRateCards(),
});
