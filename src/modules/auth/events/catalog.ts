import type { EventClassification, PublishInput } from '@core/events';

/** Classification + aggregate kind for each AUTH event (auth doc 06 §4–§5). */
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
}

/** The AUTH event catalog — the single source of delivery semantics per type. */
export const AUTH_EVENT_CATALOG: Record<string, CatalogEntry> = {
  'auth.otp.requested': { classification: 'observability', aggregateType: 'phone' },
  'auth.otp.sent': { classification: 'observability', aggregateType: 'phone' },
  'auth.otp.verified': { classification: 'audit', aggregateType: 'user' },
  'auth.login.succeeded': { classification: 'audit', aggregateType: 'user' },
  'auth.login.failed': { classification: 'observability', aggregateType: 'phone' },
  'auth.session.created': { classification: 'audit', aggregateType: 'session' },
  'auth.session.revoked': { classification: 'audit', aggregateType: 'session' },
  'auth.token.refreshed': { classification: 'observability', aggregateType: 'session' },
  'auth.refresh.reuse_detected': { classification: 'audit', aggregateType: 'session' },
  'auth.device.flagged': { classification: 'audit', aggregateType: 'device' },
  'auth.device.revoked': { classification: 'audit', aggregateType: 'device' },
  'account.role.granted': { classification: 'audit', aggregateType: 'user' },
  'account.role.revoked': { classification: 'audit', aggregateType: 'user' },
  'account.suspended': { classification: 'audit', aggregateType: 'user' },
  'account.reactivated': { classification: 'audit', aggregateType: 'user' },
  'account.recovery.completed': { classification: 'audit', aggregateType: 'user' },
};

/** Correlation/subject fields supplied when emitting an AUTH event. */
export interface AuthEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Build a {@link PublishInput} for an AUTH event, filling classification and
 * aggregate type from the catalog. The aggregate id defaults to the subject user
 * (override for session/device aggregates).
 * @param type The AUTH event type.
 * @param fields Subject/correlation ids and payload.
 * @returns A ready-to-publish event input.
 */
export function authEvent(type: string, fields: AuthEventFields): PublishInput {
  const entry = AUTH_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown AUTH event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    aggregateId: fields.aggregateId ?? fields.subjectUserId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
