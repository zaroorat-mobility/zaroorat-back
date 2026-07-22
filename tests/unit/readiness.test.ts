import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearReadinessChecks,
  registerReadinessCheck,
  runReadinessChecks,
} from '../../src/core/health/index.js';

describe('readiness checks', () => {
  afterEach(() => {
    clearReadinessChecks();
  });

  it('reports ready when nothing is registered', async () => {
    const report = await runReadinessChecks();

    assert.equal(report.ready, true);
    assert.deepEqual(report.checks, []);
  });

  it('reports ready when every probe resolves', async () => {
    registerReadinessCheck({ name: 'database', probe: async () => {} });
    registerReadinessCheck({ name: 'redis', probe: () => {} });

    const report = await runReadinessChecks();

    assert.equal(report.ready, true);
    assert.deepEqual(report.checks.map((c) => c.name).sort(), ['database', 'redis']);
  });

  it('reports not ready and names the failing dependency', async () => {
    registerReadinessCheck({ name: 'database', probe: () => {} });
    registerReadinessCheck({
      name: 'redis',
      probe: () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const report = await runReadinessChecks();

    assert.equal(report.ready, false);

    const redis = report.checks.find((c) => c.name === 'redis');
    assert.equal(redis?.ok, false);
    assert.match(redis?.error ?? '', /ECONNREFUSED/);

    // One bad dependency must not mask the healthy ones.
    assert.equal(report.checks.find((c) => c.name === 'database')?.ok, true);
  });

  it('fails a probe that hangs instead of blocking forever', async () => {
    registerReadinessCheck({
      name: 'stalled',
      probe: () => new Promise<void>(() => {}),
    });

    const report = await runReadinessChecks();

    assert.equal(report.ready, false);
    assert.match(report.checks[0]?.error ?? '', /timed out/);
  });

  it('replaces a probe registered twice under the same name', async () => {
    registerReadinessCheck({
      name: 'database',
      probe: () => {
        throw new Error('stale');
      },
    });
    registerReadinessCheck({ name: 'database', probe: () => {} });

    const report = await runReadinessChecks();

    assert.equal(report.checks.length, 1);
    assert.equal(report.ready, true);
  });
});
