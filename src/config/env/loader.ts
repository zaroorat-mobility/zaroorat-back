import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Environments that read configuration from a dotenv file on disk.
 *
 * Deployed environments (staging, production) are deliberately absent: they
 * receive configuration as injected environment variables from the platform
 * secret store, and `.env.*` is excluded by both .gitignore and .dockerignore,
 * so no such file can ever exist inside the image.
 */
const ENV_FILES: Record<string, string> = {
  development: '.env.development',
  test: '.env.test',
};

/** Environments where a missing dotenv file is a developer mistake, not normal. */
const REQUIRES_ENV_FILE = new Set(['development', 'test']);

export function loadEnvironment(): void {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';

  const envFile = ENV_FILES[appEnv];

  if (!envFile) {
    // Staging, production, and any unknown value rely on injected variables.
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

  // override: false — a real injected variable always beats the file.
  dotenv.config({
    path: envPath,
    override: false,
  });
}
