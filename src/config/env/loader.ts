import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ENV_FILES: Record<string, string> = {
  local: ".env.local",
  test: ".env.test",
};

export function loadEnvironment(): void {
  const appEnv = process.env.APP_ENV ?? "local";

  const envFile = ENV_FILES[appEnv];

  if (!envFile) {
    // Staging and Production rely on injected environment variables.
    return;
  }

  const envPath = path.resolve(process.cwd(), envFile);

  if (!fs.existsSync(envPath)) {
    throw new Error(`Environment file "${envFile}" not found.`);
  }

  dotenv.config({
    path: envPath,
    override: false,
  });
}
