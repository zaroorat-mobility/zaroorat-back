import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { FileService } from '@modules/files';
import type { EventPublisher } from '@core/events';
import type { User } from '@core/database/types';
import type { RoleRepository, UserRepository } from '@modules/auth/repositories';
import { UserProfileRepository, type UpdateUserProfileInput } from '../repositories';
import { userEvent } from '../events';
import { UniqueConstraintError } from '@core/database';
import { EmailInUseError, UserNotFoundError } from '../errors';
import type { UserProfile } from '../types';
import type { UserAccountView, UserProfileView } from '../schemas';
import { toProfileView } from './profile';
function toAccountView(user: User, profile: UserProfile | null, roles: string[]): UserAccountView {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    email: user.email,
    isPhoneVerified: user.isPhoneVerified,
    isEmailVerified: user.isEmailVerified,
    status: user.status,
    roles,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    profile: toProfileView(profile),
  };
}
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly fileService: FileService,
  ) {}
  async getMe(userId: string): Promise<UserAccountView> {
    const [user, profile, roles] = await Promise.all([
      this.userRepository.findById(userId),
      this.userProfileRepository.findByUserId(userId),
      this.roleRepository.findActiveRoleSlugs(userId),
    ]);
    if (!user || user.deletedAt !== null) {
      throw new UserNotFoundError('Account not found');
    }
    return toAccountView(user, profile, roles);
  }
  async updateProfile(
    userId: string,
    changes: UpdateUserProfileInput,
    requestId: string | null = null,
  ): Promise<UserProfileView> {
    const changedFields = Object.keys(changes);
    if (changedFields.length === 0) {
      return toProfileView(await this.userProfileRepository.findByUserId(userId));
    }
    // `User.email` is unique, so a duplicate surfaces as a UniqueConstraintError
    // from the write below. Left unmapped it reached the client as a 500.
    const profile = await this.writeProfile(async (tx) => {
      const outgoing =
        'profileImageFileId' in changes
          ? await this.attachProfileImage(userId, changes.profileImageFileId ?? null, tx, requestId)
          : null;
      const updated = await this.userProfileRepository.update(userId, changes, tx);
      if ('email' in changes) {
        await this.userRepository.updateEmail(userId, changes.email ?? null, tx);
      }
      if (outgoing !== null) {
        await this.fileService.releaseInTransaction(outgoing, userId, tx, requestId);
      }
      await this.eventPublisher.publish(
        userEvent('user.profile.updated', {
          subjectUserId: userId,
          requestId,
          data: { userId, changedFields },
        }),
        tx,
      );
      return updated;
    });
    return toProfileView(profile);
  }
  private async writeProfile<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.transactionManager.execute(callback);
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw new EmailInUseError();
      throw err;
    }
  }
  private async attachProfileImage(
    userId: string,
    nextFileId: string | null,
    tx: TransactionClient,
    requestId: string | null,
  ): Promise<string | null> {
    const current = (await this.userProfileRepository.findByUserId(userId, tx))?.profileImageFileId;
    if ((current ?? null) === nextFileId) return null;
    if (nextFileId === null) return current ?? null;
    await this.fileService.assertReferenceable(nextFileId, userId, 'PROFILE_IMAGE', tx);
    if (current != null) {
      await this.fileService.supersede(current, nextFileId, tx, requestId);
    }
    return null;
  }
}
