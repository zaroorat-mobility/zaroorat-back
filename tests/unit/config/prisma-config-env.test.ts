import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

// prisma.config.ts reads APP_ENV and loads a dotenv file when it is imported, so each case
// runs it in a fresh process whose working directory holds only that case's files.
const CONFIG = path.resolve(__dirname, '../../../prisma.config.ts');
const TSX_CLI = require.resolve('tsx/cli');
const MARKER = 'ZR_PRISMA_CONFIG_MARKER';

function loadedMarker(cwd: string, appEnv: string): string {
  const probe = path.join(cwd, 'probe.ts');
  fs.writeFileSync(
    probe,
    `import(${JSON.stringify(pathToFileURL(CONFIG).href)}).then(() => console.log('MARKER=' + (process.env.${MARKER} ?? '')));\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: appEnv };
  delete env[MARKER];
  delete env.NODE_ENV;
  const run = spawnSync(process.execPath, [TSX_CLI, probe], { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return /MARKER=(.*)/.exec(run.stdout)?.[1]?.trim() ?? '';
}

describe('prisma.config.ts env-file selection', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-prisma-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string) => fs.writeFileSync(path.join(dir, name), `${MARKER}=${name}\n`);

  it('development loads .env.local before the legacy .env.development', () => {
    write('.env.local');
    write('.env.development');
    assert.equal(loadedMarker(dir, 'development'), '.env.local');
  });

  it('development still loads a legacy .env.development', () => {
    write('.env.development');
    assert.equal(loadedMarker(dir, 'development'), '.env.development');
  });

  it('test loads .env.test', () => {
    write('.env.test');
    write('.env.local');
    assert.equal(loadedMarker(dir, 'test'), '.env.test');
  });

  it('production behaves as before: .env.production, never a development file', () => {
    write('.env.production');
    write('.env.local');
    write('.env.development');
    assert.equal(loadedMarker(dir, 'production'), '.env.production');
  });

  it('staging never falls through to a development file', () => {
    write('.env.local');
    write('.env.development');
    assert.equal(loadedMarker(dir, 'staging'), '');
    write('.env.staging');
    assert.equal(loadedMarker(dir, 'staging'), '.env.staging');
  });

  it('an unknown environment loads nothing', () => {
    write('.env.local');
    write('.env.development');
    assert.equal(loadedMarker(dir, 'dev'), '');
  });
});
