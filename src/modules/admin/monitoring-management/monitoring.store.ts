import { redis } from '@core/cache/client.js';

const ERROR_KEY = 'admin:monitoring:errors';
const ALERT_ACK_KEY = 'admin:monitoring:alert-acks';
const ERROR_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ERRORS = 500;

export interface StoredErrorEvent {
  id: string;
  message: string;
  source: string;
  severity: 'error' | 'warn';
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export async function appendErrorEvent(
  event: Omit<StoredErrorEvent, 'id' | 'occurredAt'> & { id?: string; occurredAt?: string },
): Promise<StoredErrorEvent> {
  const stored: StoredErrorEvent = {
    id: event.id ?? crypto.randomUUID(),
    message: event.message,
    source: event.source,
    severity: event.severity,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };
  await redis
    .multi()
    .lpush(ERROR_KEY, JSON.stringify(stored))
    .ltrim(ERROR_KEY, 0, MAX_ERRORS - 1)
    .expire(ERROR_KEY, ERROR_TTL_SECONDS)
    .exec();
  return stored;
}

export async function listErrorEvents(limit = 50): Promise<StoredErrorEvent[]> {
  const rows = await redis.lrange(ERROR_KEY, 0, Math.max(0, limit - 1));
  return rows
    .map((row) => {
      try {
        return JSON.parse(row) as StoredErrorEvent;
      } catch {
        return null;
      }
    })
    .filter((row): row is StoredErrorEvent => row !== null);
}

export async function acknowledgeAlert(alertId: string, actorId: string): Promise<void> {
  await redis.hset(
    ALERT_ACK_KEY,
    alertId,
    JSON.stringify({ actorId, acknowledgedAt: new Date().toISOString() }),
  );
}

export async function getAlertAcks(): Promise<
  Map<string, { actorId: string; acknowledgedAt: string }>
> {
  const rows = await redis.hgetall(ALERT_ACK_KEY);
  const out = new Map<string, { actorId: string; acknowledgedAt: string }>();
  for (const [id, value] of Object.entries(rows)) {
    try {
      out.set(id, JSON.parse(value) as { actorId: string; acknowledgedAt: string });
    } catch {
      // skip malformed ack
    }
  }
  return out;
}
