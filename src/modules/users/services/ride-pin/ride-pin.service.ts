import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { ridePinConfig } from '@config';
import { UserRepository } from '@modules/auth/repositories';
import { OtpService, type SendOtpResult } from '@modules/auth/services/otp';
import { hashRidePin, isBlockedRidePin, verifyRidePin } from '@modules/auth/utils';
import { AccountSuspendedError, RateLimitedError } from '@modules/auth/errors';
import { RIDE_PIN_RATE_LIMIT_SCOPE, RIDE_PIN_RESET_PURPOSE } from '../../constants';
import {
  RidePinAlreadySetError,
  RidePinInvalidError,
  RidePinWeakError,
  UserNotFoundError,
} from '../../errors';
import { userEvent } from '../../events';
import { UserMetrics } from '../../metrics';
import type { RidePinStatusView } from '../../schemas/user.responses';

export interface SetRidePinInput {
  userId: string;
  newPin: string;
  currentPin?: string;
  requestId?: string | null;
}
export interface RequestRidePinResetInput {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}
export interface VerifyRidePinResetInput {
  userId: string;
  challengeId: string;
  code: string;
  newPin: string;
  requestId?: string | null;
}

/// The rider's standing 4-digit Ride PIN: set it, change it, reset a forgotten
/// one. Nothing here reads it back — see `status`.
///
/// This service owns the PIN's lifecycle only. Verifying a PIN at ride start is
/// a separate concern in the rides module, because it needs the ride row to
/// resolve which customer's PIN to check, and its throttling has to survive a
/// transaction rollback in a way this path does not.
export class RidePinService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly otpService: OtpService,
    private readonly redisService: RedisService,
    private readonly eventPublisher: EventPublisher,
    private readonly userMetrics: UserMetrics,
  ) {}

  /// Whether a PIN exists, not what it is. The verifier is a one-way digest, so
  /// there is nothing to return even for the rider who owns it — and that is the
  /// point: storing it reversibly so it could be displayed would put every
  /// rider's standing PIN in a database dump in usable form.
  async status(userId: string): Promise<RidePinStatusView> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    return {
      configured: user.ridePinVerifier !== null,
      updatedAt: user.ridePinUpdatedAt,
      version: user.ridePinVersion,
    };
  }

  /// First set and change are one endpoint because they are one rider intent,
  /// and because splitting them would make "do I already have a PIN?" a question
  /// the client has to ask first — an extra round trip whose answer the server
  /// has to re-check anyway.
  ///
  /// Whether `currentPin` is required is decided by the stored verifier, never
  /// by the body: omitting the field when a PIN exists is refused rather than
  /// treated as a first set.
  async setPin(input: SetRidePinInput): Promise<RidePinStatusView> {
    // Before the account lookup and before any scrypt work: a change is a
    // credential test, so an unthrottled one is a 10,000-guess oracle for anyone
    // holding a stolen session.
    await this.assertNotRateLimited(input.userId);
    const user = await this.userRepository.findById(input.userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    if (user.status !== 'ACTIVE') throw new AccountSuspendedError();

    if (user.ridePinVerifier !== null) {
      if (input.currentPin === undefined) throw new RidePinAlreadySetError();
      if (!verifyRidePin(input.currentPin, user.ridePinVerifier)) {
        this.userMetrics.ridePinRejected({ reason: 'current_pin' });
        throw new RidePinInvalidError();
      }
    }
    this.assertAcceptable(input.newPin);

    const method = user.ridePinVerifier === null ? 'set' : 'change';
    return this.commit(input.userId, input.newPin, method, input.requestId ?? null);
  }

  /// Step one of a forgotten-PIN reset: prove control of the registered number.
  ///
  /// Reuses the auth OTP challenge under a purpose of its own, exactly as the
  /// phone-change flow does. A dedicated purpose is what stops a login code
  /// being replayed here — the OTP secret lives under a purpose-scoped key.
  ///
  /// The code goes to the number already on the account, never to one supplied
  /// in the request, so this cannot be steered at a number the caller controls.
  async requestReset(input: RequestRidePinResetInput): Promise<SendOtpResult> {
    await this.assertNotRateLimited(input.userId);
    const user = await this.userRepository.findById(input.userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    if (user.status !== 'ACTIVE') throw new AccountSuspendedError();
    return this.otpService.send({
      phoneNumber: user.phoneNumber,
      purpose: RIDE_PIN_RESET_PURPOSE,
      userId: input.userId,
      ...(input.ip != null ? { ip: input.ip } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
    });
  }

  /// Step two: the code plus the replacement, in one call.
  ///
  /// Deliberately not "verify the code, then accept a PIN later": a two-call
  /// shape would need a short-lived server-side token standing for "this caller
  /// may now set a PIN", which is another credential to store, expire and get
  /// wrong. The old PIN is never required and never returned — a rider who has
  /// forgotten it by definition cannot supply it.
  async verifyReset(input: VerifyRidePinResetInput): Promise<RidePinStatusView> {
    const user = await this.userRepository.findById(input.userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    if (user.status !== 'ACTIVE') throw new AccountSuspendedError();
    // Checked before the OTP is consumed. A weak PIN rejected afterwards would
    // burn the rider's code and make them request another one to be told
    // something the server already knew.
    this.assertAcceptable(input.newPin);
    await this.otpService.verify({
      phoneNumber: user.phoneNumber,
      purpose: RIDE_PIN_RESET_PURPOSE,
      code: input.code,
      challengeId: input.challengeId,
    });
    return this.commit(input.userId, input.newPin, 'reset', input.requestId ?? null);
  }

  private assertAcceptable(pin: string): void {
    // Shape is already enforced by the zod schema at the edge; this is the
    // judgement call the schema cannot make — `1234` is well-formed and still
    // refused, because it is the first thing anybody guesses.
    if (isBlockedRidePin(pin)) {
      this.userMetrics.ridePinRejected({ reason: 'weak' });
      throw new RidePinWeakError();
    }
  }

  private async assertNotRateLimited(userId: string): Promise<void> {
    const decision = await this.redisService.rateLimit.hit(
      RIDE_PIN_RATE_LIMIT_SCOPE,
      userId,
      ridePinConfig.changeLimit,
      ridePinConfig.changeWindowSeconds,
    );
    if (!decision.allowed) {
      this.userMetrics.ridePinRateLimited({});
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  }

  /// No transaction: this is a single-row update and one event, and the event is
  /// audit rather than domain — nothing downstream acts on it, so a publish that
  /// failed after the write would cost an audit line, not a broken invariant.
  /// Wrapping one `UPDATE` in a transaction to buy that would be ceremony.
  ///
  /// The event carries the version and the method. Never the PIN, never the
  /// verifier, never a hash of either: an outbox row is durable, replayable and
  /// read by consumers that have no business holding credential material.
  private async commit(
    userId: string,
    newPin: string,
    method: 'set' | 'change' | 'reset',
    requestId: string | null,
  ): Promise<RidePinStatusView> {
    const updatedAt = new Date();
    const version = await this.userRepository.setRidePin(userId, hashRidePin(newPin));
    await this.eventPublisher.publish(
      userEvent('user.ride_pin.changed', {
        subjectUserId: userId,
        requestId,
        data: { userId, method, version },
      }),
    );
    this.userMetrics.ridePinChanged({ method });
    return { configured: true, updatedAt, version };
  }
}
