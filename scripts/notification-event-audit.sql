-- F3 notification audit — READ-ONLY.
--
-- Which ride/payment push notifications should exist for recently published
-- outbox events but do not. Written independently of the planner, straight from
-- the notification rules, so it can cross-check the reconciliation's dry run
-- (`notification_event_reconciliation_would_recover`) rather than repeat it.
-- See docs/14_Operations/06_notification-reconciliation-go-live.md.
--
-- Window — the reconciliation's own:
--   published at least 60s ago and within the last hour, created less than an
--   hour ago (older is past its delivery TTL), one of the nine reconciled types
--   (ride offers are never reconciled).
-- Recipients — the consumer's rules:
--   the ride's customer for every ride-scoped event; also the ride's driver for
--   ride.cancelled; data.customerId for ride.request.expired;
--   payment.ride.collection_failed only when data.willRetry is literally false.
--   Ids that are not UUIDs, and rides that do not exist, yield no recipient.
-- Identity — the unique key: eventId:type:userId:PUSH.
--
-- Run:  psql "$DATABASE_URL" -f scripts/notification-event-audit.sql

WITH window_events AS (
  SELECT
    e.event_id::text AS event_id,
    e.event_type,
    e.payload -> 'data' AS data
  FROM outbox_events e
  WHERE e.status = 'PUBLISHED'
    AND e.event_type IN (
      'ride.accepted', 'ride.driver_arriving', 'ride.driver_arrived', 'ride.started',
      'ride.completed', 'ride.cancelled', 'ride.request.expired',
      'payment.ride.collected', 'payment.ride.collection_failed'
    )
    AND e.published_at >= now() - interval '1 hour'
    AND e.published_at < now() - interval '1 minute'
    AND e.created_at > now() - interval '1 hour'
),
ride_events AS (
  SELECT w.event_id, w.event_type, r.customer_id, r.driver_id
  FROM window_events w
  JOIN rides r
    ON r.id = CASE
      WHEN (w.data ->> 'rideId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (w.data ->> 'rideId')::uuid
    END
  WHERE w.event_type <> 'ride.request.expired'
    AND (w.event_type <> 'payment.ride.collection_failed' OR w.data -> 'willRetry' = 'false'::jsonb)
),
expected AS (
  -- The customer of the ride.
  SELECT event_id, event_type, 'customer' AS audience, customer_id::text AS user_id
  FROM ride_events
  UNION ALL
  -- The driver of a cancelled ride.
  SELECT re.event_id, re.event_type, 'driver', d.user_id::text
  FROM ride_events re
  JOIN drivers d ON d.id = re.driver_id
  WHERE re.event_type = 'ride.cancelled'
  UNION ALL
  -- An expired request's customer, from the payload.
  SELECT event_id, event_type, 'customer', data ->> 'customerId'
  FROM window_events
  WHERE event_type = 'ride.request.expired'
    AND (data ->> 'customerId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
SELECT
  x.event_type,
  x.audience,
  count(*) AS expected,
  count(*) FILTER (WHERE n.id IS NULL) AS missing
FROM expected x
LEFT JOIN notifications n
  ON n.idempotency_key = x.event_id || ':' || x.event_type || ':' || x.user_id || ':PUSH'
GROUP BY x.event_type, x.audience
ORDER BY x.event_type, x.audience;
