import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
// First match wins. Only developer machines and the test runner read a dotenv file.
// Deployed environments (dev, staging, prod) get injected variables from Compose — the
// image ships no dotenv file — and must never fall back to a developer's local file.
const ENV_FILES: Record<string, readonly string[]> = {
  local: ['.env.local'],
  development: ['.env.local'],
  test: ['.env.test'],
  testing: ['.env.test'],
};
const DEFAULT_ROOTS = [process.cwd(), path.resolve(__dirname, '../../..')];
export function loadEnvironment(roots: readonly string[] = DEFAULT_ROOTS): void {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  const candidates = ENV_FILES[appEnv];
  if (!candidates) {
    return;
  }
  for (const file of candidates) {
    const envPath = roots.map((root) => path.resolve(root, file)).find((p) => fs.existsSync(p));
    if (!envPath) continue;
    dotenv.config({ path: envPath, override: false, quiet: true });
    return;
  }
  throw new Error(
    `Environment file "${candidates[0]}" not found. Copy ${candidates[0]}.example to ${candidates[0]} to get started.`,
  );
}
