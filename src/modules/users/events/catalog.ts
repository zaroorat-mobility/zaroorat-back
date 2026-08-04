import type { EventClassification, PublishInput } from '@core/events';

/** Classification + aggregate kind for each USER event (user doc 05 §3–§4). */
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
}

/** The module name stamped on every envelope this catalog produces (doc 05 §2). */
export const USER_PRODUCER = 'users';

/**
 * The USER event catalog — the single source of delivery semantics per type
 * (user doc 05 §3). Audit-class events commit in the same transaction as the
 * change they record; domain events are durable; observability is best-effort.
 *
 * An event listed here but not yet emitted belongs to a later milestone; the
 * catalog transcribes doc 05 in full so consumers can integrate against one
 * table rather than tracking which flow has shipped.
 */
export const USER_EVENT_CATALOG: Record<string, CatalogEntry> = {
  // §3.1 Profile
  'user.profile.created': { classification: 'domain', aggregateType: 'user' },
  'user.profile.updated': { classification: 'domain', aggregateType: 'user' },
  // §3.2 Phone number
  'user.phone.change_requested': { classification: 'observability', aggregateType: 'user' },
  'user.phone.changed': { classification: 'audit', aggregateType: 'user' },
  // §3.3 Account lifecycle
  'user.account.deactivated': { classification: 'audit', aggregateType: 'user' },
  'user.account.deletion_requested': { classification: 'audit', aggregateType: 'user' },
  'user.account.restored': { classification: 'audit', aggregateType: 'user' },
  // The erasure job's terminal record. Audit-class and emitted in the same
  // transaction that closes the ledger row, because it is the only surviving
  // proof the obligation was discharged — the personal data it describes is
  // gone by the time anyone reads it.
  'user.account.erased': { classification: 'audit', aggregateType: 'user' },
  // §3.4 Owned collections
  'user.emergency_contact.added': { classification: 'domain', aggregateType: 'user' },
  'user.emergency_contact.updated': { classification: 'domain', aggregateType: 'user' },
  'user.emergency_contact.removed': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.added': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.updated': { classification: 'domain', aggregateType: 'user' },
  'user.saved_place.removed': { classification: 'domain', aggregateType: 'user' },
};

/** Correlation/subject fields supplied when emitting a USER event. */
export interface UserEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Build a {@link PublishInput} for a USER event, filling classification,
 * aggregate type, and producer from the catalog.
 *
 * Payloads must satisfy doc 05 §5: identifiers, field **names**, counts, coarse
 * enums, masked phone numbers, and the user-chosen label — never a personal
 * value. That rule is enforced by review and by the test plan, not by this
 * function, which cannot know what a caller's key means.
 *
 * @param type The USER event type.
 * @param fields Subject/correlation ids and payload.
 * @returns A ready-to-publish event input.
 * @throws If `type` is not in the catalog — an unlisted event is a contract
 *         breach, not a runtime condition to tolerate.
 */
export function userEvent(type: string, fields: UserEventFields): PublishInput {
  const entry = USER_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown USER event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    producer: USER_PRODUCER,
    aggregateId: fields.aggregateId ?? fields.subjectUserId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
