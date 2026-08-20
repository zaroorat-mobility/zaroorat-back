import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
const ENV_FILES: Record<string, string> = {
  development: '.env.development',
  test: '.env.test',
};
const REQUIRES_ENV_FILE = new Set(['development', 'test']);
export function loadEnvironment(): void {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  const envFile = ENV_FILES[appEnv];
  if (!envFile) {
    return;
  }
  const envPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(envPath)) {
    if (REQUIRES_ENV_FILE.has(appEnv)) {
      throw new Error(
        `Environment file "${envFile}" not found. Copy .env.example to ${envFile} to get started.`,
      );
    }
    return;
  }
  dotenv.config({
    path: envPath,
    override: false,
  });
}
