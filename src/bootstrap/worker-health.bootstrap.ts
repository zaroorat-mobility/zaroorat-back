import { createServer, type Server, type ServerResponse } from 'node:http';
import { workerConfig } from '@config/worker/worker.config.js';
import { runReadinessChecks } from '@core/health/index.js';
import { logger } from '@shared/logger/index.js';
let draining = false;
export function markDraining(): void {
  draining = true;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
async function handle(path: string, res: ServerResponse): Promise<void> {
  if (path === '/health') {
    return send(res, 200, { status: draining ? 'draining' : 'ok' });
  }
  if (path === '/ready') {
    if (draining) {
      return send(res, 503, {
        status: 'draining',
        checks: [],
        timestamp: new Date().toISOString(),
      });
    }
    const report = await runReadinessChecks();
    return send(res, report.ready ? 200 : 503, {
      status: report.ready ? 'ready' : 'not_ready',
      checks: report.checks,
      timestamp: new Date().toISOString(),
    });
  }
  send(res, 404, { status: 'not_found' });
}
export async function startWorkerHealthServer(): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req.url ?? '/', res).catch((err: unknown) => {
      logger.error({ err }, '[worker] health probe failed');
      if (!res.headersSent) send(res, 503, { status: 'error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(workerConfig.healthPort, workerConfig.healthHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  logger.info(
    { port: workerConfig.healthPort, host: workerConfig.healthHost },
    'Worker health server listening',
  );
  return server;
}
export async function closeWorkerHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
