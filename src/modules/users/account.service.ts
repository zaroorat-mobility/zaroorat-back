import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '@config/user';
import { AuthService } from '@modules/auth';
import { EpochService } from '@modules/auth/services';
import type { UserRepository } from '@modules/auth/repositories';
import { DeletionRequestRepository, ObligationsRepository } from './repositories';
import { userEvent } from './events';
import {
  AccountHasObligationsError,
  AccountNotDeactivatedError,
  UserNotFoundError,
} from './errors';

/** The `202` body of a deletion request (doc 02 §2.8). */
export interface DeletionRequestResult {
  /** When the retention job may erase the identity — ISO-8601. */
  scheduledFor: string;
}

/** What a caller may say about why they are leaving (doc 05 §3.3). */
export type DeactivationReason = (typeof userConfig.deactivationReasons)[number];

/**
 * Departure: deactivation and the request for erasure (user doc 02 §2.7–§2.8,
 * FLOW §6, R-USER-16…21).
 *
 * **Nothing here deletes anything.** A deletion request deactivates immediately
 * and records when the retention job may act; the erasure itself is that job's
 * work, never this endpoint's (R-USER-19, R-DATA-1). The `users` row survives both
 * operations, which is what USER-INV-6 asserts.
 *
 * **Restoring is not a self-service operation and has no route here.** A
 * deactivated account cannot authenticate, so there is no authenticated call its
 * owner could make to undo this (R-USER-17). {@link restore} is the seam the
 * `admin` module calls; the HTTP surface, the `users:suspend` scope that guards
 * it, and the `admin_activity_logs` row that records the actor all belong to that
 * module (doc 01 §5, admin doc 02 §RBAC).
 */
export class AccountService {
  /**
   * @param obligationsRepository The cross-module "is this account clear?" read.
   * @param deletionRequestRepository The erasure ledger.
   * @param userRepository AUTH's identity repository (read-only here).
   * @param authService AUTH's owner of `users.status` and the session tables.
   * @param epochService Post-commit epoch bump — what actually ends access.
   * @param transactionManager Unit-of-work boundary.
   * @param eventPublisher Transactional-outbox publisher.
   */
  constructor(
    private readonly obligationsRepository: ObligationsRepository,
    private readonly deletionRequestRepository: DeletionRequestRepository,
    private readonly userRepository: UserRepository,
    private readonly authService: AuthService,
    private readonly epochService: EpochService,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  /**
   * Deactivate the caller's own account (doc 02 §2.7).
   *
   * The status change, the session revocation, and the audit event are one
   * transaction (R-USER-29); the epoch bump — the thing that actually invalidates
   * every outstanding access token — runs after it commits (R-USER-30).
   *
   * Idempotent: an account that is already deactivated is a no-op. That path is
   * only reachable by a second request already in flight when the first committed,
   * since afterwards the caller can no longer authenticate.
   *
   * @param userId Subject from the verified token.
   * @param reason Coarse departure reason, if the client offered one.
   * @param requestId Correlation id for the event envelope.
   * @throws {AccountHasObligationsError} A ride, balance, or dispute is open.
   */
  async deactivate(
    userId: string,
    reason: DeactivationReason | null = null,
    requestId: string | null = null,
  ): Promise<void> {
    await this.close(userId, async (tx) => {
      await this.eventPublisher.publish(
        userEvent('user.account.deactivated', {
          subjectUserId: userId,
          requestId,
          // `actor` distinguishes this from an ops suspension, which is AUTH's
          // `account.suspended` with a different actor and different copy.
          data: { userId, actor: 'self', ...(reason ? { reason } : {}) },
        }),
        tx,
      );
    });
  }

  /**
   * Request erasure of the caller's own account (doc 02 §2.8).
   *
   * Performs the deactivation above **and** records the request, so the two can
   * never diverge: an account whose deletion is on record is always already shut.
   *
   * The ledger row is written in the **same transaction** as the audit event.
   * Before that row existed the endpoint's only durable trace was the event
   * itself — a dispatch queue, not a ledger — so the promise was made and nothing
   * could discharge it (`IMPLEMENTATION_STATUS` §8.3).
   *
   * A repeat returns the **original** date rather than a new one. The user was
   * told when their data would be gone; asking again is not consent to move it.
   *
   * @param userId Subject from the verified token.
   * @param requestId Correlation id for the event envelope.
   * @returns When the retention job may erase the identity.
   * @throws {AccountHasObligationsError} A ride, balance, or dispute is open.
   */
  async requestDeletion(
    userId: string,
    requestId: string | null = null,
  ): Promise<DeletionRequestResult> {
    const proposed = new Date(Date.now() + userConfig.deletionRetentionDays * 86_400_000);
    const scheduledFor = proposed.toISOString();

    await this.close(userId, async (tx) => {
      await this.deletionRequestRepository.open(userId, proposed, tx);

      // The departure itself is audited exactly as §2.7 audits it — no invented
      // reason, because the client did not give one.
      await this.eventPublisher.publish(
        userEvent('user.account.deactivated', {
          subjectUserId: userId,
          requestId,
          data: { userId, actor: 'self' },
        }),
        tx,
      );
      await this.eventPublisher.publish(
        userEvent('user.account.deletion_requested', {
          subjectUserId: userId,
          requestId,
          data: { userId, scheduledFor },
        }),
        tx,
      );
    });

    // Answer with the date on record, not the one just computed. They differ
    // only when a duplicate request was already in flight — and then the recorded
    // one is the date the first response promised.
    const recorded = await this.deletionRequestRepository.findPending(userId);
    return { scheduledFor: recorded?.scheduledFor.toISOString() ?? scheduledFor };
  }

  /**
   * Restore a self-deactivated account, on an operator's authority (R-USER-17).
   *
   * Called by the `admin` module, never by the account's owner — that is the whole
   * point of the requirement, and the reason this has no route in doc 02. The
   * caller is responsible for the operator's authentication, the `users:suspend`
   * scope, and the `admin_activity_logs` row; this method owns only what USER
   * owns: the status change and the event that says a *self-deactivation* was
   * undone.
   *
   * Nothing is granted back. The status change restores the ability to
   * authenticate, not the sessions that ended with the departure — the user logs
   * in again, and gets the same identity with all of its history (USER-INV-6).
   * No epoch bump, for the same reason: the epoch was raised to invalidate
   * credentials, and lowering it would revive them.
   *
   * @param userId The account to restore.
   * @param actorId The operator performing it — recorded in the audit event.
   * @param requestId Correlation id for the event envelope.
   * @throws {UserNotFoundError} No such identity, or it has been erased.
   * @throws {AccountNotDeactivatedError} The account is not `DEACTIVATED`. An
   *         account returning from ops **suspension** is AUTH's `activate`, which
   *         emits AUTH's `account.reactivated` instead (doc 05 §3.3).
   */
  async restore(userId: string, actorId: string, requestId: string | null = null): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    if (user.status !== 'DEACTIVATED') throw new AccountNotDeactivatedError();

    await this.transactionManager.execute(async (tx) => {
      await this.authService.activateInTransaction(userId, tx);
      // Restoring an account cancels its pending erasure, in the same
      // transaction. Without this the account comes back, the user logs in and
      // uses it, and the job erases them on the original date anyway — the one
      // failure in this module that is silent, dated, and irreversible.
      await this.deletionRequestRepository.cancelForUser(userId, new Date(), tx);
      await this.eventPublisher.publish(
        userEvent('user.account.restored', {
          subjectUserId: userId,
          requestId,
          // `actorId` is the operator, not the subject — the pair is what makes
          // this auditable at all (doc 05 §3.3).
          data: { userId, actor: 'admin', actorId },
        }),
        tx,
      );
    });
  }

  /**
   * The shared shape of both departures: refuse if anything is in flight, shut the
   * account and its sessions, write the caller's audit trail, then bump the epoch.
   *
   * The obligation check runs **before** the transaction rather than inside it.
   * It reads three other modules' tables, and holding a write transaction open
   * across those reads would put USER's departure flow in the lock path of
   * `rides`, `wallet`, and `support`. The window this opens — a ride starting
   * between the check and the commit — closes on its own: the ride's own module
   * sees a `DEACTIVATED` customer, and no session survives to start another.
   */
  private async close(
    userId: string,
    audit: (tx: TransactionClient) => Promise<void>,
  ): Promise<void> {
    const obligations = await this.obligationsRepository.findOpenObligations(userId);
    if (obligations.length > 0) throw new AccountHasObligationsError(obligations);

    const changed = await this.transactionManager.execute(async (tx) => {
      const { alreadyDeactivated } = await this.authService.deactivateInTransaction(userId, tx);
      // A repeat announces nothing: the account was already shut, so there is no
      // second departure to audit and no second revocation to report.
      if (alreadyDeactivated) return false;
      await audit(tx);
      return true;
    });

    if (changed) await this.epochService.bump(userId);
  }
}
