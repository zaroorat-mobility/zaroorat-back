import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Environment handling: load the dotenv file matching the current environment.
// Deployed environments have no such file and rely on injected variables, so a
// miss here is not an error.
const env = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const envFile =
  env === 'production'
    ? '.env.production'
    : env === 'test' || env === 'testing'
      ? '.env.test'
      : '.env.development';

// quiet: true is required, not cosmetic. dotenv v17 prints a banner to stdout,
// which lands inside the SQL whenever a prisma command is redirected, e.g.
// `prisma migrate diff --script > migration.sql`.
dotenv.config({ path: path.resolve(process.cwd(), envFile), quiet: true });

export default defineConfig({
  schema: 'prisma/schema',

  // `datasource`, not `migrate`. schema.prisma declares no url, so migration
  // and introspection commands read the connection string from here.
  // Spread conditionally: exactOptionalPropertyTypes rejects an explicit
  // `url: undefined`, which is also what prisma sees when DATABASE_URL is unset.
  datasource: {
    ...(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {}),
  },

  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
});
