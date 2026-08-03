import { BaseRepository, DatabaseService } from '@core/database';
import type { OtpVerification, OtpPurpose } from '@core/database/types';

/** Terminal states recorded on an OTP attempt row (auth doc 03 §3). */
export type OtpOutcome = 'sent' | 'verified' | 'failed' | 'expired' | 'locked';

/** Non-secret metadata for one OTP attempt. The code/hash is NEVER stored
 *  here — it lives only in Redis (auth doc 02 §4.5). */
export interface CreateOtpAttemptInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  userId?: string | null;
  ipAddress?: string | null;
  deviceId?: string | null;
  deviceFingerprint?: string | null;
  userAgent?: string | null;
  provider?: string | null;
  providerRef?: string | null;
  latencyMs?: number | null;
  failureReason?: string | null;
  outcome?: OtpOutcome | null;
  expiresAt: Date;
}

/** Optional fields recorded when an outcome is updated. */
export interface UpdateOutcomeOptions {
  verifiedAt?: Date;
  failureReason?: string;
}

/**
 * Data access for the `OtpVerification` trail.
 *
 * This table is a purgeable fraud/audit log of OTP *attempts* (phone, purpose,
 * outcome, ip, device, timestamps) — it is NOT a verification store. The secret
 * is verified against Redis; nothing here can validate an OTP (auth doc 02 §4.5,
 * doc 03). Prisma-only, no business rules.
 */
export class OtpRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Record a new OTP attempt in the trail.
   * @param input Non-secret attempt metadata plus its expiry.
   * @returns The created trail row.
   */
  async create(input: CreateOtpAttemptInput): Promise<OtpVerification> {
    return this.client.otpVerification.create({
      data: {
        phoneNumber: input.phoneNumber,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        ...(input.userId != null ? { userId: input.userId } : {}),
        ...(input.ipAddress != null ? { ipAddress: input.ipAddress } : {}),
        ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
        ...(input.deviceFingerprint != null ? { deviceFingerprint: input.deviceFingerprint } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        ...(input.provider != null ? { provider: input.provider } : {}),
        ...(input.providerRef != null ? { providerRef: input.providerRef } : {}),
        ...(input.latencyMs != null ? { latencyMs: input.latencyMs } : {}),
        ...(input.failureReason != null ? { failureReason: input.failureReason } : {}),
        ...(input.outcome != null ? { outcome: input.outcome } : {}),
      },
    });
  }

  /**
   * Fetch an attempt/challenge row by id (used to classify a failed verify as
   * expired vs. wrong without leaking existence).
   * @param id Attempt row UUID (the challenge id).
   * @returns The row, or `null` if unknown.
   */
  async findById(id: string): Promise<OtpVerification | null> {
    return this.client.otpVerification.findUnique({ where: { id } });
  }

  /**
   * Update the recorded outcome of an attempt (e.g. `sent` → `verified`).
   *
   * **`verified` is terminal.** The write is conditional on the row not already
   * carrying a `verified_at`, which makes the transition non-regressive under
   * concurrency: when several clients present the same code at once, exactly one
   * wins the atomic Redis consume and the losers record failures against the same
   * challenge row. An unconditional update let whichever finished last decide the
   * trail, so a login that genuinely succeeded could be filed as `failed` — with
   * `verified_at` still set, contradicting itself — and the fraud reads in
   * `countByPhoneSince` and the outcome column would disagree about what happened
   * (R-AUTH-21/22).
   *
   * Ordering does not matter: a late `verified` still overwrites an earlier
   * `failed`, and a late `failed` cannot overwrite an earlier `verified`.
   *
   * @param id Attempt row UUID.
   * @param outcome New terminal/interim outcome.
   * @param options Optional `verifiedAt` and `failureReason` to record.
   * @returns `true` if this call wrote the outcome; `false` if the attempt was
   *          already verified (or the id is unknown) and was left alone.
   */
  async updateOutcome(
    id: string,
    outcome: OtpOutcome,
    options?: UpdateOutcomeOptions,
  ): Promise<boolean> {
    const { count } = await this.client.otpVerification.updateMany({
      where: { id, verifiedAt: null },
      data: {
        outcome,
        ...(options?.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
        ...(options?.failureReason ? { failureReason: options.failureReason } : {}),
      },
    });
    return count === 1;
  }

  /**
   * Count attempts for a phone number since a cutoff (fraud/observability reads).
   * @param phoneNumber E.164 phone number.
   * @param since Lower bound (inclusive) on `createdAt`.
   * @returns Number of matching attempt rows.
   */
  async countByPhoneSince(phoneNumber: string, since: Date): Promise<number> {
    return this.client.otpVerification.count({
      where: { phoneNumber, createdAt: { gte: since } },
    });
  }

  /**
   * Purge expired attempt rows (retention R-AUTH-26).
   * @param now Rows with `expiresAt` strictly before this are deleted.
   * @returns Count of rows removed.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.client.otpVerification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}
