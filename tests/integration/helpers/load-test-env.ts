/**
 * Integration tests must never load `.env.development`. `createApp` reads
 * `APP_ENV` at import time, so this file has to be the first import from
 * `harness.ts`.
 *
 * `dotenv.config({ override: false })` keeps a shell `DATABASE_URL`, which is
 * how `tsx --test` against this suite truncated the development admin seed.
 * Dropping those keys lets `.env.test` win.
 */
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
