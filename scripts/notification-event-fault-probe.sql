-- F3 staging fault probe — STAGING ONLY. Never run against production.
--
-- Reproduces the exact gap the outbox reconciliation closes: the live consumer's
-- notification insert fails, it swallows the failure (as it must), and the relay
-- still marks the event PUBLISHED. While the probe is installed, every new
-- `ride.started` notification insert is rejected by a CHECK constraint.
-- `NOT VALID` skips checking existing rows, so installing it is instant.
--
-- Keep the reconciliation in `dry-run` (or `off`) while the probe is installed:
-- an `on` run would hit the same constraint, record a permanent failure and move
-- past the event. Procedure: docs/14_Operations/06_notification-reconciliation-go-live.md.

-- INJECT
ALTER TABLE notifications
  ADD CONSTRAINT f3_fault_probe CHECK (event_key IS DISTINCT FROM 'ride.started') NOT VALID;

-- REMOVE
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS f3_fault_probe;
