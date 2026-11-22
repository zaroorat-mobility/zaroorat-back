import type { AppPlatform } from '@core/database/types';
export interface DeviceContext {
  deviceId?: string | null;
  platform?: AppPlatform | null;
  fingerprint?: string | null;
  isRooted?: boolean | null;
  isJailbroken?: boolean | null;
  fcmToken?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
}
