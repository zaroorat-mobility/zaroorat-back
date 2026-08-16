import type { EventClassification, PublishInput } from '@core/events';
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
  version?: number;
}
export const USER_PRODUCER = 'users';
export const USER_EVENT_CATALOG = {
  'user.profile.created': { classification: 'domain', aggregateType: 'user' },
  'user.profile.updated': { classification: 'domain', aggregateType: 'user' },
  'user.phone.change_requested': { classification: 'observability', aggregateType: 'user' },
  'user.phone.changed': { classification: 'audit', aggregateType: 'user' },
  'user.account.deactivated': { classification: 'audit', aggregateType: 'user' },
  'user.account.deletion_requested': { classification: 'audit', aggregateType: 'user' },
  'user.account.restored': { classification: 'audit', aggregateType: 'user' },
  'user.account.erased': { classification: 'audit', aggregateType: 'user' },
  'user.emergency_contact.added': { classification: 'domain', aggregateType: 'user' },
  'user.emergency_contact.updated': { classification: 'domain', aggregateType: 'user' },
  'user.emergency_contact.removed': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.added': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.updated': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.removed': { classification: 'domain', aggregateType: 'user' },
} satisfies Record<string, CatalogEntry>;
export type UserEventType = keyof typeof USER_EVENT_CATALOG;
export interface UserEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}
export function userEvent(type: UserEventType, fields: UserEventFields): PublishInput {
  const entry: CatalogEntry | undefined = USER_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown USER event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    producer: USER_PRODUCER,
    ...(entry.version != null ? { version: entry.version } : {}),
    aggregateId: fields.aggregateId ?? fields.subjectUserId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
