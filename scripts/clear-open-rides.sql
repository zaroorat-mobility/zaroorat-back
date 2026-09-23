-- Dev helper: clear open rides/requests so local booking can restart.
-- Usage:
--   docker exec -i zaroorat-dev-postgres-1 psql -U zaroorat -d zaroorat_dev \
--     < scripts/clear-open-rides.sql
--
-- Also heals drivers stuck in ON_TRIP after a raw SQL cancel (lifecycle
-- cancel is what normally flips them back to ONLINE).

BEGIN;

UPDATE ride_requests
SET status = 'ABANDONED'
WHERE status IN ('CREATED', 'SEARCHING');

UPDATE ride_dispatches
SET response = 'TIMEOUT',
    responded_at = COALESCE(responded_at, now())
WHERE response = 'PENDING';

UPDATE rides
SET status = 'CANCELLED_BY_SYSTEM',
    updated_at = now()
WHERE status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS');

-- Matching only offers to ONLINE drivers. A force-cancelled ride leaves
-- driver_online_status as ON_TRIP, which blocks new offers forever.
UPDATE driver_online_status dos
SET status = 'ONLINE',
    updated_at = now()
WHERE status = 'ON_TRIP'
  AND NOT EXISTS (
    SELECT 1
    FROM rides r
    WHERE r.driver_id = dos.driver_id
      AND r.status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS')
  );

COMMIT;
