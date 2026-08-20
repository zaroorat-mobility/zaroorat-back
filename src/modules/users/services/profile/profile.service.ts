import type { UserProfile } from '../../types';
import type { UserProfileView } from '../../schemas';
import { userConfig } from '../../config';
import { toDateOnly } from '../../utils';
export function toProfileView(profile: UserProfile | null): UserProfileView {
  return {
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    dateOfBirth: toDateOnly(profile?.dateOfBirth ?? null),
    gender: profile?.gender ?? null,
    profileImageFileId: profile?.profileImageFileId ?? null,
    languageCode: profile?.languageCode ?? userConfig.defaultLanguageCode,
    referralCode: profile?.referralCode ?? null,
  };
}
