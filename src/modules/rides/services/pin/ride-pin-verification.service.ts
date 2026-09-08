import type { TransactionClient } from '@core/database/TransactionManager';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { verifyRidePin } from '@modules/auth/utils';
import { RidePinInvalidError } from '../../errors/ride.errors.js';
import { RideMetrics } from '../../metrics/ride.metrics.js';

/// Verifying that the person in the car is the rider who booked it.
///
/// The credential is the *customer's* standing Ride PIN, not a per-ride secret,
/// so the question this answers is deliberately narrow:
///
///     is this the PIN of the customer who owns this ride?
///
/// never
///
///     is this a valid PIN?
///
/// Four digits are not unique and are not meant to be — two riders both
/// choosing 4827 is expected. What makes 4827 meaningful is whose account it is
/// checked against, and that comes from the ride row's `customerId`, which the
/// caller has already locked. Nothing the driver's client sends chooses the
/// account.
export class RidePinVerificationService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly rideMetrics: RideMetrics,
  ) {}

  /// Throws `RidePinInvalidError` on a wrong PIN, on a rider who has no PIN
  /// configured, and on a customer row that has gone missing — one answer for
  /// all three.
  ///
  /// A distinct "no PIN set" reply would be an oracle: a driver could probe
  /// which riders are unprotected and target exactly those. The timing matches
  /// too, because `verifyRidePin` runs the same scrypt work against a dummy
  /// verifier when none is stored — an early `return false` would leak by clock
  /// what it did not leak by status code.
  ///
  /// Takes the transaction client so the verifier is read under the same ride
  /// row lock the state transition holds, and returns the PIN version so the
  /// audit trail can name the generation it accepted without ever recording the
  /// PIN.
  async verify(
    customerId: string,
    submittedPin: string,
    tx: TransactionClient,
  ): Promise<{ version: number }> {
    const stored = await this.userRepository.findRidePin(customerId, tx);
    if (!verifyRidePin(submittedPin, stored?.ridePinVerifier ?? null)) {
      // Counted here rather than at the call site so every rejection is counted,
      // including the not-configured one. `RideMetrics.otpFailure` was the
      // equivalent for the OTP and had no callers at all, which is why a brute
      // force against the current implementation raises no signal whatsoever.
      this.rideMetrics.ridePinFailed({ reason: stored?.ridePinVerifier ? 'invalid' : 'unset' });
      throw new RidePinInvalidError();
    }
    this.rideMetrics.ridePinVerified({});
    return { version: stored?.ridePinVersion ?? 0 };
  }
}
