import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { UserProfile } from '../types';
export interface UpdateUserProfileInput {
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: Date | null;
  gender?: string | null;
  profileImageFileId?: string | null;
  languageCode?: string | null;
  email?: string | null;
}
export class UserProfileRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findByUserId(userId: string, tx?: TransactionClient): Promise<UserProfile | null> {
    return (tx ?? this.client).userProfile.findUnique({ where: { userId } });
  }
  async ensureExists(userId: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).userProfile.createMany({
      data: { userId },
      skipDuplicates: true,
    });
    return count === 1;
  }
  async isProfileImage(fileId: string, tx?: TransactionClient): Promise<boolean> {
    const count = await (tx ?? this.client).userProfile.count({
      where: { profileImageFileId: fileId },
    });
    return count > 0;
  }
  async update(
    userId: string,
    input: UpdateUserProfileInput,
    tx?: TransactionClient,
  ): Promise<UserProfile> {
    const data: UpdateUserProfileInput = {};
    if ('firstName' in input) data.firstName = input.firstName;
    if ('lastName' in input) data.lastName = input.lastName;
    if ('dateOfBirth' in input) data.dateOfBirth = input.dateOfBirth;
    if ('gender' in input) data.gender = input.gender;
    if ('profileImageFileId' in input) data.profileImageFileId = input.profileImageFileId;
    if ('languageCode' in input) data.languageCode = input.languageCode;
    return (tx ?? this.client).userProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
  async deleteForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userProfile.deleteMany({ where: { userId } });
    return count;
  }
}
