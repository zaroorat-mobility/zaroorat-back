import type { EventEnvelope } from './types';

export type EventHandler = (envelope: EventEnvelope) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface DeliveryResult {
  delivered: number;
  failures: unknown[];
}

const ALL = '*';

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  async emit(envelope: EventEnvelope): Promise<DeliveryResult> {
    const subscribers = [
      ...(this.handlers.get(envelope.type) ?? []),
      ...(this.handlers.get(ALL) ?? []),
    ];

    const settled = await Promise.allSettled(subscribers.map(async (handler) => handler(envelope)));

    return {
      delivered: settled.filter((result) => result.status === 'fulfilled').length,
      failures: settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    };
  }

  on(type: string, handler: EventHandler): Unsubscribe {
    return this.register(type, handler);
  }

  onAny(handler: EventHandler): Unsubscribe {
    return this.register(ALL, handler);
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  private register(channel: string, handler: EventHandler): Unsubscribe {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(channel);
    };
  }
}
