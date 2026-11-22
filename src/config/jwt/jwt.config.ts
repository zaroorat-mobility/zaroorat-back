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
  } catch {
    // Malformed JSON falls through to the empty map below.
  }
  return {};
}
function parseDurationToSeconds(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const trimmed = val.trim();
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isFinite(num) && num > 0) return num;
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(trimmed);
  if (!match) return fallback;
  const count = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  switch (unit) {
    case 's':
      return count;
    case 'm':
      return count * 60;
    case 'h':
      return count * 3600;
    case 'd':
      return count * 86400;
    case 'w':
      return count * 604800;
    default:
      return fallback;
  }
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
  accessTtlSeconds: parseDurationToSeconds(
    process.env.JWT_ACCESS_TTL_SECONDS ?? process.env.JWT_ACCESS_EXPIRES_IN,
    900,
  ),
  refreshTtlSeconds: parseDurationToSeconds(
    process.env.JWT_REFRESH_TTL_SECONDS ?? process.env.JWT_REFRESH_EXPIRES_IN,
    2592000,
  ),
  issuer: process.env.JWT_ISSUER ?? 'zaroorat',
  revokedRetentionDays: Number(process.env.JWT_REFRESH_RETENTION_DAYS ?? 30),
});
export type JwtConfig = typeof jwtConfig;
