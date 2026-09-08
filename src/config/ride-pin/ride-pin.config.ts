import { createHmac } from 'node:crypto';
import { validatedEnv } from '../env/validated-env.js';
import { numericEnv } from '../env/numeric.js';

/// The pepper protecting every rider's Ride PIN verifier.
///
/// Deployed environments must set `RIDE_PIN_PEPPER` — `EnvironmentSchema`
/// refuses to boot production or staging without it, so this fallback can only
/// ever run in development or test. It exists purely so a developer does not
/// need to invent a secret to run the suite, and it is deliberately NOT the
/// pattern `otpConfig.pepper` uses in production: a Ride PIN outlives every
/// token, so chaining it to the token secret would mean rotating JWTs silently
/// locked every rider out of starting a ride.
function resolvePepper(): string {
  if (validatedEnv.RIDE_PIN_PEPPER) return validatedEnv.RIDE_PIN_PEPPER;
  return createHmac('sha256', validatedEnv.JWT_REFRESH_SECRET)
    .update('zaroorat:ride-pin:dev-only-pepper:v1')
    .digest('hex');
}

/// PINs a rider may not choose.
///
/// Four digits is 10,000 values, but riders do not pick uniformly: repeated
/// digits and simple runs account for a disproportionate share of real-world
/// choices, and those are exactly the values a driver would try first. Refusing
/// the fattest buckets costs a rider one retry and removes the cheapest attack.
///
/// Deliberately small. It is not a dictionary — blocking too much makes the PIN
/// harder to remember, which pushes riders towards writing it down, and a PIN on
/// a sticky note is worse than 2580 ever was.
function buildBlocklist(): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (let digit = 0; digit <= 9; digit += 1) {
    blocked.add(String(digit).repeat(4));
  }
  const digits = '0123456789';
  for (let start = 0; start + 4 <= digits.length; start += 1) {
    const run = digits.slice(start, start + 4);
    blocked.add(run);
    blocked.add([...run].reverse().join(''));
  }
  // Wraps the decade boundary, so the loop above misses them.
  blocked.add('9012');
  blocked.add('2109');
  return blocked;
}

export interface RidePinConfig {
  pepper: string;
  length: number;
  blocklist: ReadonlySet<string>;
  /// Set/change/reset attempts allowed per account per window. Guards the
  /// `currentPin` check on the change path, which is a credential test of its
  /// own and would otherwise be an unthrottled oracle.
  changeLimit: number;
  changeWindowSeconds: number;
  /// Wrong PINs tolerated on one ride before the driver is locked out of
  /// starting it. The window doubles as the lockout: once the budget is spent
  /// there are no more attempts until it expires, and `retryAfterSec` tells the
  /// driver when. A separate lock key would say the same thing twice.
  verifyRideLimit: number;
  verifyRideWindowSeconds: number;
  /// Failures against one rider's PIN, across every driver they ride with. A
  /// per-ride cap alone cannot see two drivers each spending five guesses on the
  /// same person.
  verifyCustomerLimit: number;
  verifyCustomerWindowSeconds: number;
  /// Failures by one driver, across every rider they carry. Catches the farming
  /// pattern — many customers, a few guesses each — which is invisible to both
  /// budgets above.
  verifyDriverLimit: number;
  verifyDriverWindowSeconds: number;
  /// Minimum gap between two attempts on the same ride. Removes rapid-fire
  /// scripting; a human typing four digits never notices it.
  verifyCooldownSeconds: number;
}

export const ridePinConfig: RidePinConfig = Object.freeze({
  pepper: resolvePepper(),
  length: 4,
  blocklist: buildBlocklist(),
  changeLimit: numericEnv('RIDE_PIN_CHANGE_LIMIT', 5, { min: 1, integer: true }),
  changeWindowSeconds: numericEnv('RIDE_PIN_CHANGE_WINDOW', 3600, { min: 1, integer: true }),
  verifyRideLimit: numericEnv('RIDE_PIN_VERIFY_RIDE_LIMIT', 5, { min: 1, integer: true }),
  verifyRideWindowSeconds: numericEnv('RIDE_PIN_VERIFY_RIDE_WINDOW', 7200, {
    min: 1,
    integer: true,
  }),
  verifyCustomerLimit: numericEnv('RIDE_PIN_VERIFY_CUSTOMER_LIMIT', 10, { min: 1, integer: true }),
  verifyCustomerWindowSeconds: numericEnv('RIDE_PIN_VERIFY_CUSTOMER_WINDOW', 86400, {
    min: 1,
    integer: true,
  }),
  verifyDriverLimit: numericEnv('RIDE_PIN_VERIFY_DRIVER_LIMIT', 20, { min: 1, integer: true }),
  verifyDriverWindowSeconds: numericEnv('RIDE_PIN_VERIFY_DRIVER_WINDOW', 86400, {
    min: 1,
    integer: true,
  }),
  verifyCooldownSeconds: numericEnv('RIDE_PIN_VERIFY_COOLDOWN', 2, { min: 0, integer: true }),
});
