/// The one vocabulary for APP_ENV. `development`, `testing` and `production` are the
/// pre-2026-11 spellings of `local`, `test` and `prod`, and must behave identically: a guard
/// that recognises only one spelling silently switches itself off for the other. Every
/// environment check goes through the three predicates below, never a raw string compare.
export const APP_ENVIRONMENTS = ['local', 'dev', 'test', 'staging', 'prod'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const LEGACY: Readonly<Record<string, AppEnvironment>> = {
  development: 'local',
  testing: 'test',
  production: 'prod',
};

export function normalizeEnvironment(name: string | undefined): AppEnvironment | undefined {
  if (name === undefined) return undefined;
  return (APP_ENVIRONMENTS as readonly string[]).includes(name)
    ? (name as AppEnvironment)
    : LEGACY[name];
}

/// Runs on a shared server (dev, staging, prod): fail-closed rules apply — restricted DB
/// role, real payment/SMS/push providers, mandatory encryption keys.
export function isDeployed(name: string | undefined): boolean {
  const env = normalizeEnvironment(name);
  return env === 'dev' || env === 'staging' || env === 'prod';
}

/// Holds real customers' data (staging, prod): additionally, uploads must be malware-scanned.
export function servesRealUsers(name: string | undefined): boolean {
  const env = normalizeEnvironment(name);
  return env === 'staging' || env === 'prod';
}

/// A developer machine: verbose logs, open CORS, OTP printed when SMS is mocked.
export function isLocal(name: string | undefined): boolean {
  return normalizeEnvironment(name) === 'local';
}
