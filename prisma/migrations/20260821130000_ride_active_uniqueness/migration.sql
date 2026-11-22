-- Database backstop for "one active ride per driver" and "one active ride
-- per customer" — previously application-only (LifecycleService.acceptRideRequest
-- checks RideRepository.findActiveByDriver, and RideRequestService.createRequest
-- checks RideRepository/RideRequestRepository.findActiveByCustomer), with the
-- checks and the eventual insert not covered by a lock on the driver or
-- customer, only on the request. Two different requests accepted by the same
-- driver, or two requests created by the same customer, in the same instant
-- could both still pass the applicaton check before either commits.
--
-- Mirrors the exact reasoning `20260810100000_ride_request_unique` already
-- documents for "one ride per request": the application lock is the normal
-- path, this is the backstop that makes a bypass fail loudly instead of
-- silently double-booking.
--
-- Active ride_requests statuses ('CREATED', 'SEARCHING') and active rides
-- statuses (every RideStatus except the terminal ones) are enumerated
-- explicitly rather than by exclusion, so a future status addition doesn't
-- silently become "active" here without a deliberate migration.
--
-- ## Pre-existing duplicates
--
-- Exactly like the precedent this follows, the index build FAILS if
-- duplicates already exist. Check before deploying:
--
--   SELECT driver_id, count(*) FROM rides
--   WHERE status IN ('ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS')
--   GROUP BY driver_id HAVING count(*) > 1;
--
--   SELECT customer_id, count(*) FROM rides
--   WHERE status IN ('ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','IN_PROGRESS')
--   GROUP BY customer_id HAVING count(*) > 1;
--
--   SELECT customer_id, count(*) FROM ride_requests
--   WHERE status IN ('CREATED','SEARCHING')
--   GROUP BY customer_id HAVING count(*) > 1;
--
-- On a database that has never served ride traffic these all return nothing.
--
-- Plain build, not CONCURRENTLY, for the same reason `20260810100000` and
-- `20260801000000` record: Prisma wraps each migration in a transaction and
-- CONCURRENTLY cannot run inside one. Build out-of-band with CREATE UNIQUE
-- INDEX CONCURRENTLY first on a database with real traffic and let
-- IF NOT EXISTS turn this into a no-op.

CREATE UNIQUE INDEX IF NOT EXISTS "rides_active_driver_key"
  ON "rides" ("driver_id")
  WHERE "status" IN ('ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS');

CREATE UNIQUE INDEX IF NOT EXISTS "rides_active_customer_key"
  ON "rides" ("customer_id")
  WHERE "status" IN ('ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS');

CREATE UNIQUE INDEX IF NOT EXISTS "ride_requests_active_customer_key"
  ON "ride_requests" ("customer_id")
  WHERE "status" IN ('CREATED', 'SEARCHING');
