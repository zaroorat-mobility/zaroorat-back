import { EventEmitter } from 'node:events';
import type { EventEnvelope } from './types';

/** A subscriber invoked with a delivered event envelope. */
export type EventHandler = (envelope: EventEnvelope) => void | Promise<void>;

/**
 * In-process publish/subscribe bus — the v1 substitute for an external broker.
 *
 * The outbox relay dispatches durable events here, and observability events are
 * emitted here directly. Consumers subscribe by event type or to all events. A
 * handler error is isolated so one bad subscriber cannot break delivery to
 * others (at-least-once, per-subject ordering is preserved by the relay).
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many modules may subscribe; avoid the default 10-listener warning.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Deliver an envelope to type-specific and wildcard subscribers.
   * @param envelope The event to deliver.
   */
  emit(envelope: EventEnvelope): void {
    this.emitter.emit(envelope.type, envelope);
    this.emitter.emit('*', envelope);
  }

  /**
   * Subscribe to a single event type.
   * @param type The dotted event type.
   * @param handler The subscriber.
   */
  on(type: string, handler: EventHandler): void {
    this.emitter.on(type, this.wrap(handler));
  }

  /**
   * Subscribe to every event.
   * @param handler The subscriber.
   */
  onAny(handler: EventHandler): void {
    this.emitter.on('*', this.wrap(handler));
  }

  private wrap(handler: EventHandler): (envelope: EventEnvelope) => void {
    return (envelope) => {
      try {
        void Promise.resolve(handler(envelope)).catch(() => undefined);
      } catch {
        // A subscriber must never break delivery to others.
      }
    };
  }
}
