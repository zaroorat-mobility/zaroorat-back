import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import {
  INTEGRATION_HEALTH_HISTORY_MAX,
  INTEGRATION_HEALTH_HISTORY_PREFIX,
  INTEGRATION_HEALTH_SNAPSHOT_PREFIX,
  INTEGRATION_HEALTH_TTL_SECONDS,
  type IntegrationKind,
} from '../constants/integration-settings.constants.js';
import type {
  IntegrationHealthSnapshot,
  IntegrationHealthStatus,
  IntegrationsStatusView,
} from '../types/integration-settings.types.js';

interface ProbeHistoryEntry {
  ok: boolean;
  responseTimeMs: number;
  at: string;
  message: string;
}

interface StoredSnapshot {
  integration: IntegrationKind;
  provider: string;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  recentFailureCount: number;
  p95ResponseTimeMs: number | null;
  message: string;
  probedAt: string | null;
}

export class IntegrationHealthService {
  constructor(private readonly redisService: RedisService) {}

  async recordProbe(
    integration: IntegrationKind,
    provider: string,
    input: {
      ok: boolean;
      responseTimeMs: number;
      message: string;
      configured?: boolean;
    },
  ): Promise<IntegrationHealthSnapshot> {
    const now = new Date().toISOString();
    const historyKey = `${INTEGRATION_HEALTH_HISTORY_PREFIX}:${integration}`;
    const snapshotKey = `${INTEGRATION_HEALTH_SNAPSHOT_PREFIX}:${integration}`;

    const historyEntry: ProbeHistoryEntry = {
      ok: input.ok,
      responseTimeMs: input.responseTimeMs,
      at: now,
      message: input.message,
    };

    try {
      const client = this.redisService.provider.client;
      await client.lpush(historyKey, JSON.stringify(historyEntry));
      await client.ltrim(historyKey, 0, INTEGRATION_HEALTH_HISTORY_MAX - 1);
      await client.expire(historyKey, INTEGRATION_HEALTH_TTL_SECONDS);

      const existingRaw = await client.get(snapshotKey);
      const existing = existingRaw ? (JSON.parse(existingRaw) as StoredSnapshot) : null;

      const history = await this.readHistory(integration);
      const recentFailureCount = history.filter((h) => !h.ok).length;
      const p95ResponseTimeMs = computeP95(history.map((h) => h.responseTimeMs));

      const snapshot: StoredSnapshot = {
        integration,
        provider,
        configured: input.configured ?? existing?.configured ?? true,
        lastSuccessAt: input.ok ? now : (existing?.lastSuccessAt ?? null),
        lastFailureAt: input.ok ? (existing?.lastFailureAt ?? null) : now,
        recentFailureCount,
        p95ResponseTimeMs,
        message: input.message,
        probedAt: now,
      };

      await client.set(snapshotKey, JSON.stringify(snapshot), 'EX', INTEGRATION_HEALTH_TTL_SECONDS);

      return this.toHealthSnapshot(snapshot);
    } catch (err) {
      logger.warn({ err, integration }, '[IntegrationHealthService] Failed to record probe');
      return {
        integration,
        provider,
        status: input.ok ? 'HEALTHY' : 'DOWN',
        configured: input.configured ?? true,
        lastSuccessAt: input.ok ? now : null,
        lastFailureAt: input.ok ? null : now,
        recentFailureCount: input.ok ? 0 : 1,
        p95ResponseTimeMs: input.responseTimeMs,
        message: input.message,
        probedAt: now,
      };
    }
  }

  async getIntegrationStatus(
    integration: IntegrationKind,
    fallback: {
      provider: string;
      configured: boolean;
    },
  ): Promise<IntegrationHealthSnapshot> {
    try {
      const snapshotKey = `${INTEGRATION_HEALTH_SNAPSHOT_PREFIX}:${integration}`;
      const raw = await this.redisService.provider.client.get(snapshotKey);

      if (raw) {
        const snapshot = JSON.parse(raw) as StoredSnapshot;
        return this.toHealthSnapshot({
          ...snapshot,
          configured: snapshot.configured ?? fallback.configured,
          provider: snapshot.provider || fallback.provider,
        });
      }
    } catch (err) {
      logger.warn({ err, integration }, '[IntegrationHealthService] Failed to read snapshot');
    }

    return {
      integration,
      provider: fallback.provider,
      status: fallback.configured ? 'WARNING' : 'DOWN',
      configured: fallback.configured,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentFailureCount: 0,
      p95ResponseTimeMs: null,
      message: fallback.configured ? 'Configured but not probed recently' : 'Not configured',
      probedAt: null,
    };
  }

  async getAggregateStatus(
    fallbacks: Array<{
      integration: IntegrationKind;
      provider: string;
      configured: boolean;
    }>,
  ): Promise<IntegrationsStatusView> {
    const integrations = await Promise.all(
      fallbacks.map((f) => this.getIntegrationStatus(f.integration, f)),
    );

    const overall = computeOverallStatus(integrations.map((i) => i.status));

    return { overall, integrations };
  }

  private async readHistory(integration: IntegrationKind): Promise<ProbeHistoryEntry[]> {
    try {
      const rawEntries = await this.redisService.provider.client.lrange(
        `${INTEGRATION_HEALTH_HISTORY_PREFIX}:${integration}`,
        0,
        INTEGRATION_HEALTH_HISTORY_MAX - 1,
      );
      return rawEntries
        .map((raw) => {
          try {
            return JSON.parse(raw) as ProbeHistoryEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is ProbeHistoryEntry => entry !== null);
    } catch {
      return [];
    }
  }

  private toHealthSnapshot(snapshot: StoredSnapshot): IntegrationHealthSnapshot {
    return {
      integration: snapshot.integration,
      provider: snapshot.provider,
      status: computeStatus(snapshot),
      configured: snapshot.configured,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastFailureAt: snapshot.lastFailureAt,
      recentFailureCount: snapshot.recentFailureCount,
      p95ResponseTimeMs: snapshot.p95ResponseTimeMs,
      message: snapshot.message,
      probedAt: snapshot.probedAt,
    };
  }
}

function computeP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? null;
}

function computeStatus(snapshot: StoredSnapshot): IntegrationHealthStatus {
  if (!snapshot.configured) return 'DOWN';
  if (!snapshot.probedAt) return 'WARNING';

  const historyFailures = snapshot.recentFailureCount;
  const lastFailed = snapshot.lastFailureAt && snapshot.lastFailureAt === snapshot.probedAt;

  if (lastFailed) {
    if (historyFailures >= 3) return 'CRITICAL';
    return 'DOWN';
  }

  if (historyFailures >= 3) return 'CRITICAL';
  if (historyFailures >= 1) return 'WARNING';
  if (snapshot.p95ResponseTimeMs !== null && snapshot.p95ResponseTimeMs > 3000) return 'WARNING';

  return 'HEALTHY';
}

function computeOverallStatus(statuses: IntegrationHealthStatus[]): IntegrationHealthStatus {
  if (statuses.includes('DOWN')) return 'DOWN';
  if (statuses.includes('CRITICAL')) return 'CRITICAL';
  if (statuses.includes('WARNING')) return 'WARNING';
  return 'HEALTHY';
}
