/**
 * Financial Calculation Formulas for Zaroorat Operations Dashboard
 *
 * Implements the financial logic adhering to Zaroorat's direct-driver
 * payment architecture where customers pay fares directly to drivers.
 *
 * No value is clamped. A negative component is real data: a promotion that
 * costs more than the platform's margin posts PLATFORM_COMMISSION as a DEBIT
 * (ledger.service.ts `signedLeg`), a subscription refund debits
 * SUBSCRIPTION_REVENUE, and a COMMISSION-model ride's commission is fixed at
 * acceptance (lifecycle.service.ts) so it can exceed a fare that ended short.
 */

export interface FinancialInput {
  /** Total sum of completed trip fares (RideFare.totalFare) */
  grossRideValue: number;
  /** Net platform commission earned from ride transactions (CREDIT − DEBIT) */
  rideCommission: number;
  /** Net platform fees associated with rides (CREDIT − DEBIT) */
  platformFees?: number;
  /** Net driver subscription revenue (CREDIT − DEBIT) */
  subscriptionRevenue: number;
}

export interface FinancialResult {
  /**
   * Platform Revenue: All recognized platform earnings
   * = rideCommission + platformFees + subscriptionRevenue
   */
  platformRevenue: number;
  /**
   * Gross Ride Value: Total value of rides completed
   * (paid directly by customers to drivers via Cash / UPI)
   */
  grossRideValue: number;
  /**
   * Driver Ride Collections: Net ride money kept by drivers
   * = grossRideValue - (rideCommission + platformFees)
   *
   * CRITICAL: Subscription revenue is strictly NOT subtracted from ride collections,
   * as subscription plans are independent periodic driver payments.
   */
  driverRideCollections: number;
  /** Total deductions attributable directly to rides (commission + platform fees) */
  rideDeductions: number;
  /** Recognized subscription revenue component */
  subscriptionRevenue: number;
  /** Recognized ride commission component */
  rideCommission: number;
  /** Recognized platform fee component */
  platformFees: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Calculates the core dashboard financial metrics given gross ride value and ledger components.
 * Signs are preserved; non-numeric input counts as 0.
 */
export function calculateFinancials(input: FinancialInput): FinancialResult {
  const grossRideValue = Number(input.grossRideValue) || 0;
  const rideCommission = Number(input.rideCommission) || 0;
  const platformFees = Number(input.platformFees) || 0;
  const subscriptionRevenue = Number(input.subscriptionRevenue) || 0;

  // Platform revenue = all platform earnings
  const platformRevenue = round2(rideCommission + platformFees + subscriptionRevenue);

  // Ride-related platform deductions (commission + ride platform fees)
  const rideDeductions = round2(rideCommission + platformFees);

  // Driver ride collections = gross fare - ride deductions
  const driverRideCollections = round2(grossRideValue - rideDeductions);

  return {
    platformRevenue,
    grossRideValue: round2(grossRideValue),
    driverRideCollections,
    rideDeductions,
    subscriptionRevenue: round2(subscriptionRevenue),
    rideCommission: round2(rideCommission),
    platformFees: round2(platformFees),
  };
}

/**
 * Percentage change from `previous` to `current`, rounded to 1 decimal place.
 *
 * Returns null when `previous` is 0: a change relative to nothing has no defined
 * percentage, and reporting +100 % (or 0 %) would invent a comparison.
 */
export function calculatePercentageChange(current: number, previous: number): number | null {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;

  if (prev === 0) return null;

  const change = ((curr - prev) / Math.abs(prev)) * 100;
  return Math.round(change * 10) / 10;
}
