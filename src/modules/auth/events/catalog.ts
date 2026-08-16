import type { EventClassification, PublishInput } from '@core/events';
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
  version?: number;
}
export const AUTH_PRODUCER = 'auth';
export const AUTH_EVENT_CATALOG = {
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
} satisfies Record<string, CatalogEntry>;
export type AuthEventType = keyof typeof AUTH_EVENT_CATALOG;
export interface AuthEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}
export function authEvent(type: AuthEventType, fields: AuthEventFields): PublishInput {
  const entry: CatalogEntry | undefined = AUTH_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown AUTH event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    producer: AUTH_PRODUCER,
    ...(entry.version != null ? { version: entry.version } : {}),
    aggregateId: fields.aggregateId ?? fields.subjectUserId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
