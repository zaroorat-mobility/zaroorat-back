export type EventClassification = 'audit' | 'domain' | 'observability';
export const DURABLE_CLASSIFICATIONS: readonly EventClassification[] = ['audit', 'domain'];
export function isDurable(classification: EventClassification): boolean {
  return DURABLE_CLASSIFICATIONS.includes(classification);
}
export interface EventEnvelope {
  eventId: string;
  type: string;
  version: number;
  envelopeVersion: number;
  occurredAt: string;
  producer: string;
  subject: {
    userId: string | null;
  };
  correlation: {
    requestId: string | null;
    sessionId: string | null;
  };
  data: Record<string, unknown>;
}
export interface PublishInput {
  type: string;
  classification: EventClassification;
  aggregateType: string;
  producer: string;
  version?: number;
  aggregateId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  data: Record<string, unknown>;
}
