import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

// Must be set before the config module is first evaluated: it reads the port at
// import time, like every other config in this codebase.
process.env.WORKER_HEALTH_PORT = '34117';

type HealthModule = typeof import('../../../src/bootstrap/worker-health.bootstrap.js');

let health: HealthModule;
let server: Server;

const BASE = 'http://127.0.0.1:34117';

async function probe(path: string): Promise<{ status: number; body: { status: string } }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as { status: string } };
}

describe('worker health server', () => {
  before(async () => {
    health = await import('../../../src/bootstrap/worker-health.bootstrap.js');
    server = await health.startWorkerHealthServer();
  });

  after(async () => {
    await health.closeWorkerHealthServer(server);
  });

  it('serves liveness', async () => {
    const { status, body } = await probe('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('serves readiness while the registered checks pass', async () => {
    const { status, body } = await probe('/ready');
    assert.equal(status, 200);
    assert.equal(body.status, 'ready');
  });

  it('404s anything else — the worker has no public surface', async () => {
    const { status } = await probe('/metrics');
    assert.equal(status, 404);
  });

  // Ordered last: draining is a one-way latch, exactly as it is in the process.
  describe('once draining', () => {
    before(() => {
      health.markDraining();
    });

    it('fails readiness so the pod is pulled before jobs are abandoned', async () => {
      const { status, body } = await probe('/ready');
      assert.equal(status, 503);
      assert.equal(body.status, 'draining');
    });

    it('keeps liveness passing, so the drain is never cut short by a restart', async () => {
      const { status, body } = await probe('/health');
      assert.equal(status, 200, 'a draining worker is working, not wedged');
      assert.equal(body.status, 'draining');
    });
  });
});
