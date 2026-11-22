import type { EventClassification, PublishInput } from '@core/events';
interface CatalogEntry {
  classification: EventClassification;
  aggregateType: string;
  version?: number;
}
export const FILE_PRODUCER = 'files';
export const FILE_EVENT_CATALOG = {
  'file.uploaded': { classification: 'domain', aggregateType: 'file' },
  'file.read': { classification: 'audit', aggregateType: 'file' },
  'file.deleted': { classification: 'audit', aggregateType: 'file' },
  'file.superseded': { classification: 'audit', aggregateType: 'file' },
  'file.erased': { classification: 'audit', aggregateType: 'file' },
} satisfies Record<string, CatalogEntry>;
export type FileEventType = keyof typeof FILE_EVENT_CATALOG;
export interface FileEventFields {
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
}
export function fileEvent(type: FileEventType, fields: FileEventFields): PublishInput {
  const entry: CatalogEntry | undefined = FILE_EVENT_CATALOG[type];
  if (!entry) throw new Error(`Unknown FILES event type: ${type}`);
  return {
    type,
    classification: entry.classification,
    aggregateType: entry.aggregateType,
    producer: FILE_PRODUCER,
    ...(entry.version != null ? { version: entry.version } : {}),
    aggregateId: fields.aggregateId ?? null,
    subjectUserId: fields.subjectUserId ?? null,
    sessionId: fields.sessionId ?? null,
    requestId: fields.requestId ?? null,
    data: fields.data ?? {},
  };
}
