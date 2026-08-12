import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '../../config';
import { AuthService } from '@modules/auth';
import { EpochService } from '@modules/auth/services';
import type { UserRepository } from '@modules/auth/repositories';
import { DeletionRequestRepository, ObligationsRepository } from '../../repositories';
import { userEvent } from '../../events';
import {
  AccountHasObligationsError,
  AccountNotDeactivatedError,
  UserNotFoundError,
} from '../../errors';
import type { DeletionRequestResult } from '../../schemas';

export type DeactivationReason = (typeof userConfig.deactivationReasons)[number];

export class AccountService {
  constructor(
    private readonly obligationsRepository: ObligationsRepository,
    private readonly deletionRequestRepository: DeletionRequestRepository,
    private readonly userRepository: UserRepository,
    private readonly authService: AuthService,
    private readonly epochService: EpochService,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

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
          data: { userId, actor: 'self', ...(reason ? { reason } : {}) },
        }),
        tx,
      );
    });
  }

  async requestDeletion(
    userId: string,
    requestId: string | null = null,
  ): Promise<DeletionRequestResult> {
    const proposed = new Date(Date.now() + userConfig.deletionRetentionDays * 86_400_000);
    const scheduledFor = proposed.toISOString();

    await this.close(userId, async (tx) => {
      await this.deletionRequestRepository.open(userId, proposed, tx);

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

    const recorded = await this.deletionRequestRepository.findPending(userId);
    return { scheduledFor: recorded?.scheduledFor.toISOString() ?? scheduledFor };
  }

  async restore(userId: string, actorId: string, requestId: string | null = null): Promise<void> {
    await this.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);

      const user = await this.userRepository.findById(userId, tx);
      if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
      if (user.status !== 'DEACTIVATED') throw new AccountNotDeactivatedError();

      await this.authService.activateInTransaction(userId, tx);
      await this.deletionRequestRepository.cancelForUser(userId, new Date(), tx);
      await this.eventPublisher.publish(
        userEvent('user.account.restored', {
          subjectUserId: userId,
          requestId,
          data: { userId, actor: 'admin', actorId },
        }),
        tx,
      );
    });
  }

  private async close(
    userId: string,
    audit: (tx: TransactionClient) => Promise<void>,
  ): Promise<void> {
    const changed = await this.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);

      const user = await this.userRepository.findById(userId, tx);
      if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');

      const obligations = await this.obligationsRepository.findOpenObligations(userId, tx);
      if (obligations.length > 0) throw new AccountHasObligationsError(obligations);

      const { alreadyDeactivated } = await this.authService.deactivateInTransaction(userId, tx);
      if (alreadyDeactivated) return false;
      await audit(tx);
      return true;
    });

    if (changed) await this.epochService.bump(userId);
  }
}
