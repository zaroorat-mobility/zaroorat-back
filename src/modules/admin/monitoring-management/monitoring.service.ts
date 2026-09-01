import { paymentConfig } from '@config/payment/payment.config.js';
import { workerConfig } from '@config/worker/worker.config.js';
import { DatabaseService } from '@core/database';
import { runReadinessChecks } from '@core/health/index.js';
import { collectProcessMetrics, snapshotMetrics } from '@core/metrics';
import { allManagedQueues, resolveQueue } from '@/jobs/queues/index.js';
import { MapProviderHealthService } from '../system-settings/map/services/map-provider-health.service.js';
import { SystemSettingService } from '../system-settings/services/system-setting.service.js';
import {
  MAP_SETTING_KEYS,
  DEFAULT_MAP_PROVIDERS,
} from '../system-settings/map/constants/map-settings.constants.js';
import {
  acknowledgeAlert,
  getAlertAcks,
  listErrorEvents,
  type StoredErrorEvent,
} from './monitoring.store.js';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
}

export interface MonitoringHealthDto {
  overall: HealthStatus;
  components: ComponentHealth[];
  checkedAt: string;
}

export interface QueueBacklogDto {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface MonitoringPerformanceDto {
  requestTotal: number;
  errorRate: number;
  serverErrorCount: number;
  clientErrorCount: number;
  queueBacklog: QueueBacklogDto[];
  outboxPending: number | null;
  outboxFailed: number | null;
  processUptimeSeconds: number | null;
  heapUsedBytes: number | null;
  collectedAt: string;
}

export type AlertSeverity = 'critical' | 'operational' | 'business';

export interface MonitoringAlertDto {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  source: string;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('unhealthy')) return 'unhealthy';
  if (statuses.includes('degraded')) return 'degraded';
  return 'healthy';
}

function readinessToStatus(ok: boolean): HealthStatus {
  return ok ? 'healthy' : 'unhealthy';
}

async function probeWorkerHealth(): Promise<ComponentHealth> {
  const url = `http://${workerConfig.healthHost === '0.0.0.0' ? '127.0.0.1' : workerConfig.healthHost}:${workerConfig.healthPort}/ready`;
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = (await response.json()) as { status?: string };
    if (response.ok && body.status === 'ready') {
      return { name: 'workers', status: 'healthy', latencyMs: Date.now() - start };
    }
    return {
      name: 'workers',
      status: response.ok ? 'degraded' : 'unhealthy',
      message: body.status ?? `HTTP ${response.status}`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'workers',
      status: 'degraded',
      message: err instanceof Error ? err.message : 'Worker health probe unreachable',
      latencyMs: Date.now() - start,
    };
  }
}

export class AdminMonitoringService {
  constructor(
    private readonly db: DatabaseService,
    private readonly mapProviderHealthService: MapProviderHealthService,
    private readonly systemSettingService: SystemSettingService,
  ) {}

  private get client() {
    return this.db.client;
  }

  async getHealth(): Promise<MonitoringHealthDto> {
    const start = Date.now();
    const readiness = await runReadinessChecks();
    const dbCheck = readiness.checks.find((c) => c.name === 'database');
    const redisCheck = readiness.checks.find((c) => c.name === 'redis');

    const queueStatuses = await Promise.all(
      allManagedQueues().map(async ({ name }) => {
        const queue = resolveQueue(name);
        if (!queue) return { name, ok: false, error: 'queue not found' };
        try {
          await queue.getJobCounts('waiting', 'active', 'failed');
          return { name, ok: true };
        } catch (err) {
          return {
            name,
            ok: false,
            error: err instanceof Error ? err.message : 'queue probe failed',
          };
        }
      }),
    );

    const queuesOk = queueStatuses.every((q) => q.ok);
    const queueMessage = queueStatuses
      .filter((q) => !q.ok)
      .map((q) => `${q.name}: ${q.error}`)
      .join('; ');

    const paymentConfigured =
      Boolean(paymentConfig.razorpayKeyId && paymentConfig.razorpayKeySecret) ||
      Boolean(paymentConfig.stripeSecretKey) ||
      paymentConfig.defaultGateway === 'mock';

    const mapProvider = await this.resolveActiveMapProvider();
    const mapHealth = mapProvider
      ? await this.mapProviderHealthService.testProviderHealth({ providerName: mapProvider })
      : { ok: false, message: 'No map provider configured' };

    const workerHealth = await probeWorkerHealth();

    const components: ComponentHealth[] = [
      { name: 'api', status: 'healthy', latencyMs: Date.now() - start },
      {
        name: 'database',
        status: readinessToStatus(dbCheck?.ok ?? false),
        ...(dbCheck?.error ? { message: dbCheck.error } : {}),
      },
      {
        name: 'redis',
        status: readinessToStatus(redisCheck?.ok ?? false),
        ...(redisCheck?.error ? { message: redisCheck.error } : {}),
      },
      workerHealth,
      {
        name: 'queues',
        status: queuesOk ? 'healthy' : 'unhealthy',
        ...(queueMessage ? { message: queueMessage } : {}),
      },
      {
        name: 'payment',
        status: paymentConfigured ? 'healthy' : 'degraded',
        message: paymentConfigured
          ? 'Gateway credentials configured'
          : 'Payment gateway not configured',
      },
      {
        name: 'maps',
        status: mapHealth.ok ? 'healthy' : 'degraded',
        message: mapHealth.message,
        ...('responseTimeMs' in mapHealth && mapHealth.responseTimeMs !== undefined
          ? { latencyMs: mapHealth.responseTimeMs }
          : {}),
      },
    ];

    return {
      overall: worstStatus(components.map((c) => c.status)),
      components,
      checkedAt: new Date().toISOString(),
    };
  }

  async getPerformance(): Promise<MonitoringPerformanceDto> {
    collectProcessMetrics();
    const samples = snapshotMetrics();

    let requestTotal = 0;
    let serverErrorCount = 0;
    let clientErrorCount = 0;
    let outboxPending: number | null = null;
    let outboxFailed: number | null = null;
    let processUptimeSeconds: number | null = null;
    let heapUsedBytes: number | null = null;

    for (const sample of samples) {
      if (sample.name === 'http_requests_total') {
        requestTotal += sample.value;
        const code = sample.labels.code ?? '';
        if (code.startsWith('5')) serverErrorCount += sample.value;
        if (code.startsWith('4')) clientErrorCount += sample.value;
      }
      if (sample.name === 'outbox_pending' && Object.keys(sample.labels).length === 0) {
        outboxPending = sample.value;
      }
      if (sample.name === 'outbox_failed' && Object.keys(sample.labels).length === 0) {
        outboxFailed = sample.value;
      }
      if (sample.name === 'process_uptime_seconds' && Object.keys(sample.labels).length === 0) {
        processUptimeSeconds = sample.value;
      }
      if (sample.name === 'nodejs_heap_used_bytes' && Object.keys(sample.labels).length === 0) {
        heapUsedBytes = sample.value;
      }
    }

    const queueBacklog = await Promise.all(
      allManagedQueues().map(async ({ name }) => {
        const queue = resolveQueue(name);
        if (!queue) {
          return { queue: name, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
        }
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        return {
          queue: name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
        };
      }),
    );

    const errorRate = requestTotal > 0 ? Number((serverErrorCount / requestTotal).toFixed(4)) : 0;

    return {
      requestTotal,
      errorRate,
      serverErrorCount,
      clientErrorCount,
      queueBacklog,
      outboxPending,
      outboxFailed,
      processUptimeSeconds,
      heapUsedBytes,
      collectedAt: new Date().toISOString(),
    };
  }

  async getErrors(limit = 50): Promise<{ data: StoredErrorEvent[] }> {
    const dbErrors = await this.client.outboxEvent.findMany({
      where: { status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        lastError: true,
        createdAt: true,
        aggregateType: true,
      },
    });

    const redisErrors = await listErrorEvents(limit);

    const merged: StoredErrorEvent[] = [
      ...dbErrors.map((row) => ({
        id: row.id,
        message: row.lastError ?? 'Outbox event failed',
        source: `outbox:${row.aggregateType}`,
        severity: 'error' as const,
        occurredAt: row.createdAt.toISOString(),
        metadata: { eventType: row.eventType },
      })),
      ...redisErrors,
    ]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);

    return { data: merged };
  }

  async getAlerts(): Promise<{ data: MonitoringAlertDto[] }> {
    const [health, performance, acks] = await Promise.all([
      this.getHealth(),
      this.getPerformance(),
      getAlertAcks(),
    ]);

    const alerts: MonitoringAlertDto[] = [];

    for (const component of health.components) {
      if (component.status === 'unhealthy') {
        alerts.push(
          this.toAlert(
            `health:${component.name}`,
            'critical',
            component.name,
            component.message ?? `${component.name} is unhealthy`,
            'health',
          ),
        );
      } else if (component.status === 'degraded') {
        alerts.push(
          this.toAlert(
            `health:${component.name}`,
            'operational',
            component.name,
            component.message ?? `${component.name} is degraded`,
            'health',
          ),
        );
      }
    }

    for (const queue of performance.queueBacklog) {
      if (queue.failed > 0) {
        alerts.push(
          this.toAlert(
            `queue:${queue.queue}:failed`,
            'operational',
            `Queue ${queue.queue} has failed jobs`,
            `${queue.failed} failed job(s) in ${queue.queue}`,
            'jobs',
          ),
        );
      }
      if (queue.waiting > 100) {
        alerts.push(
          this.toAlert(
            `queue:${queue.queue}:backlog`,
            'business',
            `Queue ${queue.queue} backlog`,
            `${queue.waiting} waiting job(s) in ${queue.queue}`,
            'jobs',
          ),
        );
      }
    }

    if ((performance.outboxPending ?? 0) > 50) {
      alerts.push(
        this.toAlert(
          'outbox:pending',
          'operational',
          'Outbox backlog',
          `${performance.outboxPending} pending outbox event(s)`,
          'outbox',
        ),
      );
    }

    if ((performance.outboxFailed ?? 0) > 0) {
      alerts.push(
        this.toAlert(
          'outbox:failed',
          'critical',
          'Outbox failures',
          `${performance.outboxFailed} failed outbox event(s)`,
          'outbox',
        ),
      );
    }

    if (performance.errorRate > 0.05 && performance.requestTotal > 20) {
      alerts.push(
        this.toAlert(
          'api:error-rate',
          'critical',
          'Elevated API error rate',
          `Server error rate is ${(performance.errorRate * 100).toFixed(1)}% over ${performance.requestTotal} requests`,
          'api',
        ),
      );
    }

    const enriched = alerts.map((alert) => {
      const ack = acks.get(alert.id);
      return {
        ...alert,
        acknowledged: Boolean(ack),
        ...(ack?.acknowledgedAt ? { acknowledgedAt: ack.acknowledgedAt } : {}),
        ...(ack?.actorId ? { acknowledgedBy: ack.actorId } : {}),
      };
    });

    return { data: enriched.sort((a, b) => a.severity.localeCompare(b.severity)) };
  }

  async ackAlert(alertId: string, actorId: string): Promise<void> {
    await acknowledgeAlert(alertId, actorId);
  }

  private toAlert(
    id: string,
    severity: AlertSeverity,
    title: string,
    message: string,
    source: string,
  ): MonitoringAlertDto {
    return {
      id,
      severity,
      title,
      message,
      source,
      createdAt: new Date().toISOString(),
      acknowledged: false,
    };
  }

  private async resolveActiveMapProvider(): Promise<'ola' | 'google' | 'mappls' | null> {
    const provider =
      (await this.systemSettingService.getSettingValue(MAP_SETTING_KEYS.PRIMARY_PROVIDER)) ??
      DEFAULT_MAP_PROVIDERS.PRIMARY;
    if (provider === 'ola' || provider === 'google' || provider === 'mappls') return provider;
    if (await this.systemSettingService.getSettingValue(MAP_SETTING_KEYS.OLA_API_KEY)) return 'ola';
    if (await this.systemSettingService.getSettingValue(MAP_SETTING_KEYS.GOOGLE_API_KEY)) {
      return 'google';
    }
    if (await this.systemSettingService.getSettingValue(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)) {
      return 'mappls';
    }
    return null;
  }
}
