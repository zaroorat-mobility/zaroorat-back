/**
 * Integration tests must never load `.env.development`. `createApp` reads
 * `APP_ENV` at import time, so this file has to be the first import from
 * `harness.ts`.
 *
 * It cannot rely on being the first import of the *process*, though. A test
 * file that imports anything under `src/` before `./helpers/harness.js` pulls
 * in `validated-env`, whose module body calls `loadEnvironment()` — so
 * `.env.test` is already loaded by the time this runs. The previous version
 * deleted `DATABASE_URL` and `REDIS_URL` here and left `loadEnvironment()` to
 * put them back; in that order nothing ever did, and every test in the file
 * died on `resetState()` refusing an unset `DATABASE_URL`.
 *
 * Loading `.env.test` here with `override: true` makes the order irrelevant:
 * these values win whether they were set by an earlier `dotenv` pass or
 * exported in the shell (a shell `DATABASE_URL` pointing at development is
 * what truncated the development admin seed once).
 */
import path from 'node:path';
import dotenv from 'dotenv';

process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: true });
