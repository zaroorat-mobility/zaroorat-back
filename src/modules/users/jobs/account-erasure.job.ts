import { RedisService } from '@core/cache';
import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '@config/user';
import { FileService } from '@modules/files';
import type { UserRepository } from '@modules/auth/repositories';
import { logger } from '@shared/logger/index.js';
import {
  DeletionRequestRepository,
  EmergencyContactRepository,
  ObligationsRepository,
  SavedPlaceRepository,
  UserProfileRepository,
} from '../repositories';
import { userEvent } from '../events';
import { UserMetrics } from '../user.metrics';

/** Redis resource name for the single-runner guard. */
const ERASURE_LOCK = 'user:erasure';

/** Lock lifetime — long enough for a batch, short enough that a crash frees it. */
const ERASURE_LOCK_TTL_MS = 15 * 60 * 1000;

/** What one erasure run did. */
export interface ErasureResult {
  /** False when another runner held the lock. */
  ran: boolean;
  scanned: number;
  erased: number;
  /** Held back because an obligation is still open (R-USER-21). */
  blocked: number;
  failed: number;
}

/** What one account's erasure removed, for the audit event. */
interface ErasureCounts {
  emergencyContacts: number;
  savedPlaces: number;
  profile: number;
}

/**
 * Discharges accepted deletion requests (R-USER-18/19, doc 03 §6).
 *
 * **This is the only code in USER that destroys anything**, which is why most of
 * it is refusals. It runs against the ledger, never against a status: an account
 * being `DEACTIVATED` is not consent to erase it, only a recorded request is.
 *
 * ## What "erase" means here
 *
 * The platform resolves the tension between R-DATA-1 (financial and safety
 * records are append-only) and the DPDP right to erasure by
 * **"erasing/anonymizing personal identifiers while retaining the immutable
 * financial/safety record"** (`docs/15_Security/03` §Privacy by design). So:
 *
 * | Data                                                | Treatment  | Why |
 * | --------------------------------------------------- | ---------- | --- |
 * | `user_profiles`, `emergency_contacts`, `saved_places` | **removed** | Doc 03 §6: they live and die with the account. Contacts are personal data about *third parties*, "never retained past it" |
 * | The avatar object                                   | released   | Handed to FILES' own retention, which owns object erasure |
 * | `users` row                                         | anonymized, kept | ~50 tables reference it. Removing it would break every ride, ledger entry, and dispute the law requires us to keep |
 * | Rides, wallet, tickets                              | untouched  | The immutable record the same paragraph says to retain |
 *
 * The identity keeps its `id` and its dates and loses everything that names a
 * person. A row that cannot be linked back to a human is what erasure means when
 * the foreign keys must survive.
 */
export class AccountErasureJob {
  /**
   * @param deletionRequestRepository The ledger this job exists to discharge.
   * @param obligationsRepository The same cross-module check the request passed.
   * @param userProfileRepository The profile, and the avatar reference on it.
   * @param emergencyContactRepository Third-party personal data.
   * @param savedPlaceRepository Home and work addresses.
   * @param userRepository AUTH's identity repository — `users` is AUTH's table.
   * @param fileService FILES' owner of object lifecycle — for the avatar.
   * @param transactionManager Unit of work for one account's erasure.
   * @param eventPublisher Outbox writer for `user.account.erased`.
   * @param redisService Distributed lock, so two runners do not race one account.
   * @param userMetrics Counters.
   */
  constructor(
    private readonly deletionRequestRepository: DeletionRequestRepository,
    private readonly obligationsRepository: ObligationsRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly emergencyContactRepository: EmergencyContactRepository,
    private readonly savedPlaceRepository: SavedPlaceRepository,
    private readonly userRepository: UserRepository,
    private readonly fileService: FileService,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly userMetrics: UserMetrics,
  ) {}

  /**
   * Erase one batch of due accounts.
   *
   * Per-account failure is isolated: one account's problem leaves its request
   * `PENDING` and the next run retries it. There is no dead-letter, because
   * unlike FILES' retention this job's work is fully idempotent — every step is a
   * delete or an overwrite that is a no-op the second time — so a permanent
   * failure surfaces as a request that stays due, which the `oldest pending
   * request` gauge makes visible without a second mechanism.
   *
   * @param now The run instant; injectable so a test need not wait 30 days.
   * @returns What the run did, including `ran: false` when another holder had
   *          the lock.
   */
  async run(now: Date = new Date()): Promise<ErasureResult> {
    const token = await this.redisService.lock.acquire(ERASURE_LOCK, ERASURE_LOCK_TTL_MS);
    // Unlike the file sweeper, a second runner here is not merely wasteful: two
    // transactions erasing one account would both find rows to delete, and the
    // loser would emit a second `user.account.erased` for one erasure.
    if (!token) return { ran: false, scanned: 0, erased: 0, blocked: 0, failed: 0 };

    try {
      const due = await this.deletionRequestRepository.findDue(now, userConfig.erasureBatchSize);
      let erased = 0;
      let blocked = 0;
      let failed = 0;

      for (const request of due) {
        try {
          const outcome = await this.eraseAccount(request.id, request.userId, now);
          if (outcome === 'BLOCKED') blocked += 1;
          else erased += 1;
        } catch (err) {
          failed += 1;
          // The user id is an internal identifier, which is exactly what doc 02
          // §5 says to log instead of anything that names them.
          logger.error(
            { err, userId: request.userId },
            '[Users] erasure failed; retrying next run',
          );
        }
      }

      this.userMetrics.accountsErased({ count: erased, blocked, failed });
      return { ran: true, scanned: due.length, erased, blocked, failed };
    } finally {
      await this.redisService.lock.release(ERASURE_LOCK, token);
    }
  }

  /**
   * Erase one account, or decline to.
   *
   * The obligation check is **re-run here**, not trusted from the request. Thirty
   * days passed; a dispute can be opened about a ride taken before the account
   * closed, and erasing the identity mid-dispute destroys the other side's
   * evidence and the platform's ability to pay out. R-USER-21 gated the door on
   * the way in, and this gates it again on the way out.
   */
  private async eraseAccount(
    requestId: string,
    userId: string,
    now: Date,
  ): Promise<'ERASED' | 'BLOCKED'> {
    const obligations = await this.obligationsRepository.findOpenObligations(userId);
    if (obligations.length > 0) {
      this.userMetrics.erasureBlocked({ modules: obligations.map((o) => o.module).join(',') });
      return 'BLOCKED';
    }

    // Read the avatar before the profile row that points at it is gone.
    const avatarFileId = await this.avatarOf(userId);

    // Step 1 — the personal data, in one transaction. Idempotent: a retry after a
    // crash deletes nothing and overwrites the same columns with the same values.
    const counts = await this.transactionManager.execute((tx) => this.scrub(userId, now, tx));

    // Step 2 — the avatar object, outside the transaction because FILES owns its
    // own unit of work. It must run *after* the profile row is gone: FILES
    // refuses to delete a file a live row still references, which is the guard
    // working exactly as intended.
    if (avatarFileId) await this.releaseAvatar(avatarFileId, userId);

    // Step 3 — close the ledger last. A crash before here leaves the request
    // `PENDING` and the next run repeats steps 1–2 harmlessly; closing it first
    // would mean a crash mid-erasure is recorded as a completed erasure. The
    // audit event rides this transition, so it is emitted once, when the whole
    // thing actually finished.
    await this.transactionManager.execute(async (tx) => {
      const won = await this.deletionRequestRepository.markErased(requestId, now, tx);
      if (!won) return;
      await this.eventPublisher.publish(
        userEvent('user.account.erased', {
          subjectUserId: userId,
          // Counts, not contents. This event outlives the data it describes, so
          // it must say what was removed without becoming a copy of it (doc 05 §5).
          data: { userId, ...counts, avatarReleased: avatarFileId !== null },
        }),
        tx,
      );
    });

    return 'ERASED';
  }

  /** The account's avatar file id, if it has one. */
  private async avatarOf(userId: string): Promise<string | null> {
    const profile = await this.userProfileRepository.findByUserId(userId);
    return profile?.profileImageFileId ?? null;
  }

  /**
   * Remove the personal data and anonymize the identity, in one transaction.
   *
   * Order matters only at the end: the identity is anonymized last, so a
   * constraint failure anywhere leaves a coherent account rather than a nameless
   * one that still owns a profile.
   */
  private async scrub(userId: string, at: Date, tx: TransactionClient): Promise<ErasureCounts> {
    const emergencyContacts = await this.emergencyContactRepository.deleteAllForUser(userId, tx);
    const savedPlaces = await this.savedPlaceRepository.deleteAllForUser(userId, tx);
    const profile = await this.userProfileRepository.deleteForUser(userId, tx);

    await this.userRepository.anonymize(userId, at, tx);

    return { emergencyContacts, savedPlaces, profile };
  }

  /**
   * Hand the avatar to FILES' retention.
   *
   * Soft-deleted, not erased here. FILES owns when an object's bytes go and
   * reaching into its bucket from this module would put two schedules in charge
   * of one deletion. A file already deleted is a no-op there, so a retry is free.
   */
  private async releaseAvatar(fileId: string, userId: string): Promise<void> {
    try {
      await this.fileService.remove(fileId, userId);
    } catch (err) {
      // Never fatal to the erasure. The personal data is already gone; an
      // orphaned avatar is a bounded storage cost, and the alternative is
      // retrying the whole account because one object did not release.
      logger.warn({ err, userId }, '[Users] avatar release failed; object retained');
    }
  }
}
