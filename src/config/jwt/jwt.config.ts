import { validatedEnv } from '../env/validated-env.js';

/**
 * JWT / token policy. Secrets come from the validated environment; TTLs and the
 * issuer follow the auth security/API specs (access 15 min, refresh 30 days —
 * docs/auth/02 §3.1, 04 §2.2) and are overridable via the environment.
 * `refreshSecret` doubles as the HMAC pepper for refresh-token hashing (doc 02 §3.4).
 */
export const jwtConfig = Object.freeze({
  accessSecret: validatedEnv.JWT_ACCESS_SECRET,
  refreshSecret: validatedEnv.JWT_REFRESH_SECRET,
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 2592000),
  issuer: process.env.JWT_ISSUER ?? 'zaroorat',
});

export type JwtConfig = typeof jwtConfig;
