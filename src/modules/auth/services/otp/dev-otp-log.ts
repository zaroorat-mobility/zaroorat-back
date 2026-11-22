import { isLocal } from '@config/env/environment.js';

/// Whether the freshly generated OTP may be written to the log. Only on a developer
/// machine that delivers nothing (APP_ENV=local, SMS_PROVIDER=mock): there the log
/// is the only way to read the code. Every other combination, including local with
/// a real gateway, keeps the code out of the log.
export function shouldLogDevOtp(environment: string, smsProvider: string | undefined): boolean {
  return isLocal(environment) && smsProvider === 'mock';
}
