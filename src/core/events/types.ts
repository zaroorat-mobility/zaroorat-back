/**
 * Delivery classification (auth doc 06 §4). Determines the delivery guarantee:
 * `audit`/`domain` events are durable (written to the outbox in the state
 * change's transaction); `observability` events are best-effort (emitted
 * directly to the in-process bus).
 */
export type EventClassification = 'audit' | 'domain' | 'observability';

/** The canonical event envelope (auth doc 06 §3). */
export interface EventEnvelope {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  producer: string;
  subject: { userId: string | null };
  correlation: { requestId: string | null; sessionId: string | null };
  data: Record<string, unknown>;
}

/** Input describing a domain event to publish. */
export interface PublishInput {
  /** Dotted event type, e.g. `auth.login.succeeded`. */
  type: string;
  /** Delivery classification (routes to outbox vs. bus). */
  classification: EventClassification;
  /** Aggregate kind for the outbox row (`user` | `session` | `device` | …). */
  aggregateType: string;
  /** Emitting module stamped on the envelope. Defaults to `auth` (auth doc 06
   *  §3); the users module stamps `users` (user doc 05 §2). */
  producer?: string;
  /** Aggregate id — a UUID; required for durable (outbox) events. */
  aggregateId?: string | null;
  /** Subject user id for the envelope. */
  subjectUserId?: string | null;
  /** Correlation ids for tracing. */
  sessionId?: string | null;
  requestId?: string | null;
  /** Non-secret payload (auth doc 06 §5–§6). */
  data: Record<string, unknown>;
}
