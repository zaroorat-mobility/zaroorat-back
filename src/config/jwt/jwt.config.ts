/* eslint-disable no-empty */
import { validatedEnv } from '../env/validated-env.js';

const primaryKid = process.env.JWT_PRIMARY_KID ?? 'v1';
const defaultAccessSecret = validatedEnv.JWT_ACCESS_SECRET;

function parseSecretsJson(): Record<string, string> {
  if (!process.env.JWT_ACCESS_SECRETS_JSON) return {};
  try {
    const parsed = JSON.parse(process.env.JWT_ACCESS_SECRETS_JSON);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

const parsedSecrets = parseSecretsJson();

export const jwtConfig = Object.freeze({
  primaryKid,
  accessSecret: defaultAccessSecret,
  accessSecrets: Object.freeze<Record<string, string>>({
    [primaryKid]: defaultAccessSecret,
    ...parsedSecrets,
    ...(process.env.JWT_OLD_ACCESS_SECRET
      ? { [process.env.JWT_OLD_KID ?? 'v0']: process.env.JWT_OLD_ACCESS_SECRET }
      : {}),
  }),
  refreshSecret: validatedEnv.JWT_REFRESH_SECRET,
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 2592000),
  issuer: process.env.JWT_ISSUER ?? 'zaroorat',
  revokedRetentionDays: Number(process.env.JWT_REFRESH_RETENTION_DAYS ?? 30),
});

export type JwtConfig = typeof jwtConfig;
