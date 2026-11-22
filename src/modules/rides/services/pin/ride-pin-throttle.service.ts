import { RedisService } from '@core/cache';
import { ridePinConfig } from '@config';
import { logger } from '@shared/logger/index.js';
import {
  RidePinLockedError,
  RidePinThrottledError,
  RidePinUnavailableError,
} from '../../errors/ride.errors.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';

const SCOPE_RIDE = 'ride:pin:ride';
const SCOPE_CUSTOMER = 'ride:pin:cust';
const SCOPE_DRIVER = 'ride:pin:drv';
const SCOPE_COOLDOWN = 'ride:pin';

export interface RidePinAttempt {
  rideId: string;
  driverId: string;
  customerId: string;
}

/// Attempt accounting for the Ride PIN, in Redis, on purpose.
///
/// The whole point of this class is *where it does not live*. The ride OTP it
/// replaces counted its attempts with a conditional UPDATE on the transaction
/// client, and then threw — so the exception that signalled a wrong code rolled
/// back the very row that recorded it, and the five-attempt cap never engaged
/// in production even though a unit test with an in-memory fake said it did.
///
/// Nothing here touches the ride transaction. `assertAllowed` runs before it
/// opens, `recordFailure` after it has already rolled back. A counter that must
/// survive a rollback cannot be written by the thing being rolled back.
///
/// ## Failures, not attempts
///
/// The per-customer and per-driver budgets are spent on *failures only*, which
/// is why the pre-check reads (`peek`) rather than increments. Counting every
/// attempt would mean a driver doing twenty honest rides in a day hit the
/// twenty-failure driver cap on the twentieth passenger and could not start it —
/// the throttle would take the platform down by working exactly as designed.
///
/// The per-ride budget is likewise only spent on failures, and is cleared
/// outright on success.
export class RidePinThrottle {
  constructor(
    private readonly redisService: RedisService,
    private readonly rideMetrics: RideMetrics,
  ) {}

  /// Called before the ride transaction opens. Throws if any budget is already
  /// spent, or if two attempts arrive inside the cooldown.
  ///
  /// The cooldown is checked last: it is the only one of these that *spends*
  /// something, and there is no point burning it on a caller who was going to be
  /// refused by a budget anyway.
  async assertAllowed(attempt: RidePinAttempt): Promise<void> {
    const budgets = await this.guard(() =>
      Promise.all([
        this.redisService.rateLimit.peek(SCOPE_RIDE, attempt.rideId, ridePinConfig.verifyRideLimit),
        this.redisService.rateLimit.peek(
          SCOPE_CUSTOMER,
          attempt.customerId,
          ridePinConfig.verifyCustomerLimit,
        ),
        this.redisService.rateLimit.peek(
          SCOPE_DRIVER,
          attempt.driverId,
          ridePinConfig.verifyDriverLimit,
        ),
      ]),
    );
    const scopes = [SCOPE_RIDE, SCOPE_CUSTOMER, SCOPE_DRIVER] as const;
    const spentAt = budgets.findIndex((budget) => !budget.allowed);
    if (spentAt !== -1) {
      // The scope goes to the metric but never to the driver — the response says
      // only "too many attempts". `scope` is what makes the driver budget
      // alertable, and a run of `scope="drv"` lockouts is the collusion signal
      // no per-ride counter could ever surface.
      this.rideMetrics.ridePinLocked({ scope: scopes[spentAt] ?? 'unknown' });
      throw new RidePinLockedError(budgets[spentAt]!.retryAfterSeconds);
    }

    if (ridePinConfig.verifyCooldownSeconds > 0) {
      const gap = await this.guard(() =>
        this.redisService.rateLimit.enforceMinInterval(
          SCOPE_COOLDOWN,
          attempt.rideId,
          ridePinConfig.verifyCooldownSeconds,
        ),
      );
      if (!gap.allowed) throw new RidePinThrottledError(gap.retryAfterSeconds);
    }
  }

  /// Called after the ride transaction has rolled back, so the record outlives
  /// it. All three budgets move together: a wrong PIN is simultaneously an
  /// attempt against this ride, against this rider's credential, and by this
  /// driver.
  ///
  /// Not `guard`ed, and deliberately not allowed to fail silently: if the store
  /// is unreachable the caller has already been refused by `assertAllowed`, so
  /// reaching here at all means Redis was up moments ago. An error is logged and
  /// swallowed rather than replacing the driver's "wrong PIN" with a 503 —
  /// telling them the PIN was fine when it was not would be worse than losing
  /// one increment.
  async recordFailure(attempt: RidePinAttempt): Promise<void> {
    try {
      await Promise.all([
        this.redisService.rateLimit.hit(
          SCOPE_RIDE,
          attempt.rideId,
          ridePinConfig.verifyRideLimit,
          ridePinConfig.verifyRideWindowSeconds,
        ),
        this.redisService.rateLimit.hit(
          SCOPE_CUSTOMER,
          attempt.customerId,
          ridePinConfig.verifyCustomerLimit,
          ridePinConfig.verifyCustomerWindowSeconds,
        ),
        this.redisService.rateLimit.hit(
          SCOPE_DRIVER,
          attempt.driverId,
          ridePinConfig.verifyDriverLimit,
          ridePinConfig.verifyDriverWindowSeconds,
        ),
      ]);
    } catch (err) {
      logger.error(
        { err, rideId: attempt.rideId },
        '[rides] could not record a failed Ride PIN attempt',
      );
    }
  }

  /// Called after a start commits. Clears this ride's budget only.
  ///
  /// The customer and driver budgets are not cleared: they are abuse windows
  /// spanning many rides, and a driver who guessed wrong on four riders before
  /// getting the fifth right has still made four failed attempts. Wiping that on
  /// any success would let an attacker launder their history through one
  /// legitimate ride.
  async clear(rideId: string): Promise<void> {
    try {
      await this.redisService.rateLimit.reset(SCOPE_RIDE, rideId);
    } catch (err) {
      logger.warn({ err, rideId }, '[rides] could not clear the Ride PIN attempt counter');
    }
  }

  /// Fail closed. Every other security store in this codebase does — the auth
  /// plugin refuses a request whose revocation, permission, device or driver
  /// state it cannot read — and a lone exception here is how an inconsistency
  /// becomes an incident.
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      logger.error({ err }, '[rides] Ride PIN throttle store unavailable — failing closed');
      throw new RidePinUnavailableError();
    }
  }
}
