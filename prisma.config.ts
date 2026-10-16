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
  //
  // MIGRATION_DATABASE_URL is the schema owner, for `prisma migrate deploy` only. Deployed
  // environments set it on the migration job and DATABASE_URL (the restricted runtime
  // login) on the app — the app never reads this file. Locally only DATABASE_URL is set,
  // and it is used for both.
  datasource: (() => {
    const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    return url ? { url } : {};
  })(),

  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
});
