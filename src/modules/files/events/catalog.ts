import type { EventClassification, PublishInput } from '@core/events';

/** Classification + aggregate kind for each FILES event (files doc 05 §2–§3). */
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
}

/** The module name stamped on every envelope this catalog produces (doc 05 §1). */
export const FILE_PRODUCER = 'files';

/**
 * The FILES event catalog — the single source of delivery semantics per type
 * (files doc 05 §3).
 *
 * **Nothing here is `observability`.** Every event is either something a
 * consumer must react to or something compliance must be able to prove, and
 * neither survives being dropped (doc 05 §2).
 *
 * An event listed here but not yet emitted belongs to a later phase; the catalog
 * transcribes doc 05 in full so consumers integrate against one table rather
 * than tracking which phase has shipped.
 */
export const FILE_EVENT_CATALOG: Record<string, CatalogEntry> = {
  // §3.1 — the bytes are verified and the file is referenceable.
  'file.uploaded': { classification: 'domain', aggregateType: 'file' },
  // §3.2 — a non-owner minted a read URL (R-FILE-15, NFR-SEC-03).
  'file.read': { classification: 'audit', aggregateType: 'file' },
  // §3.3 — soft-deleted by its owner or a module.
  'file.deleted': { classification: 'audit', aggregateType: 'file' },
  // §3.4 — replaced by a newer version (R-FILE-31).
  'file.superseded': { classification: 'audit', aggregateType: 'file' },
  // §3.5 — retention archived or destroyed the object.
  'file.erased': { classification: 'audit', aggregateType: 'file' },
};

/** Correlation/subject fields supplied when emitting a FILES event. */
export interface FileEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Build a {@link PublishInput} for a FILES event, filling classification,
 * aggregate type, and producer from the catalog.
 *
 * Payloads must satisfy doc 05 §4: identifiers, coarse enums, sizes, MIME types,
 * and the authorizing scope — **never** a signed URL, a storage key, a checksum,
 * or a `fileName`. That rule is enforced by review and by the test plan, not by
 * this function, which cannot know what a caller's key means.
 *
 * @param type The FILES event type.
 * @param fields Subject/correlation ids and payload.
 * @returns A ready-to-publish event input.
 * @throws Error if `type` is not in the catalog — an unlisted event is a
 *         contract breach, not a runtime condition to tolerate.
 */
export function fileEvent(type: string, fields: FileEventFields): PublishInput {
  const entry = FILE_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown FILES event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    producer: FILE_PRODUCER,
    aggregateId: fields.aggregateId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
