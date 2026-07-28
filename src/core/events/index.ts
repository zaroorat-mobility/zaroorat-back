export type { EventEnvelope, PublishInput, EventClassification } from './types';
export { EventBus, type EventHandler } from './EventBus';
export { OutboxRepository, type OutboxRecord, type PendingOutboxEvent } from './OutboxRepository';
export { EventPublisher } from './EventPublisher';
export { OutboxRelay } from './OutboxRelay';
export { registerEventsModule } from './EventsModule';
