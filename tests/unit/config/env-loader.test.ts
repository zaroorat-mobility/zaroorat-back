import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { loadEnvironment } from '../../../src/config/env/loader.js';

const MARKER = 'ZR_LOADER_TEST_MARKER';

describe('loadEnvironment', () => {
  let dir: string;
  const savedAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-env-'));
    delete process.env[MARKER];
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[MARKER];
    process.env.APP_ENV = savedAppEnv;
  });

  const write = (name: string, value: string) =>
    fs.writeFileSync(path.join(dir, name), `${MARKER}=${value}\n`);

  it('development reads .env.local', () => {
    process.env.APP_ENV = 'development';
    write('.env.local', 'local');
    loadEnvironment([dir]);
    assert.equal(process.env[MARKER], 'local');
  });

  it('development prefers .env.local over the legacy .env.development', () => {
    process.env.APP_ENV = 'development';
    write('.env.local', 'local');
    write('.env.development', 'legacy');
    loadEnvironment([dir]);
    assert.equal(process.env[MARKER], 'local');
  });

  it('local reads .env.local', () => {
    process.env.APP_ENV = 'local';
    write('.env.local', 'local');
    loadEnvironment([dir]);
    assert.equal(process.env[MARKER], 'local');
  });

  it('development never falls back to .env.dev or a legacy .env.development', () => {
    process.env.APP_ENV = 'development';
    write('.env.dev', 'dev-server-credentials');
    write('.env.development', 'legacy');
    assert.throws(() => loadEnvironment([dir]), /\.env\.local/);
    assert.equal(process.env[MARKER], undefined);
  });

  it('development without any file throws and names .env.local', () => {
    process.env.APP_ENV = 'development';
    assert.throws(() => loadEnvironment([dir]), /\.env\.local/);
  });

  it('test still requires .env.test', () => {
    process.env.APP_ENV = 'test';
    assert.throws(() => loadEnvironment([dir]), /\.env\.test/);
    write('.env.test', 'test');
    loadEnvironment([dir]);
    assert.equal(process.env[MARKER], 'test');
  });

  // Deployed environments: the container has no dotenv file (.dockerignore) and Compose
  // injects the variables. A missing file must not throw, and a file that happens to be
  // present (a developer's .env.local, a stray .env.dev) must never be read.
  for (const environment of ['dev', 'staging', 'prod', 'production']) {
    it(`${environment} reads no file at all (variables are injected)`, () => {
      process.env.APP_ENV = environment;
      loadEnvironment([dir]);
      write('.env.local', 'local');
      write('.env.dev', 'dev');
      write('.env.development', 'legacy');
      write(`.env.${environment}`, environment);
      loadEnvironment([dir]);
      assert.equal(process.env[MARKER], undefined);
    });
  }

  it('never overrides a variable that is already set', () => {
    process.env.APP_ENV = 'development';
    process.env[MARKER] = 'injected';
    write('.env.local', 'local');
    loadEnvironment([dir]);
    assert.equal(process.env[MARKER], 'injected');
  });
});
