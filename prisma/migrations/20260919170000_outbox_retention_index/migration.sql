-- Additive index for PostgreSQL outbox retention pruning
CREATE INDEX "outbox_events_status_published_at_idx"
  ON "outbox_events" ("status", "published_at");
