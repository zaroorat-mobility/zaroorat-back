-- One active vehicle assignment per driver, and per vehicle.
--
-- `vehicle_assignments` had no uniqueness at all — only plain indexes on
-- driver_id and vehicle_id — because nothing wrote to the table (the
-- platform audit's P1 finding: "Vehicles: nothing populates it"). Now that
-- VehicleAssignmentService.claimVehicle does
-- (VehicleAssignmentRepository.releaseActiveForDriver + create, inside one
-- transaction), the same class of race the ride-acceptance backstops already
-- guard against applies here too: two concurrent claims for the same vehicle,
-- or two concurrent claims by the same driver, could both pass an
-- unlocked read-then-write check before either commits. This is that
-- invariant's database backstop, not the primary defense — the primary
-- defense is the transaction in VehicleAssignmentService.
--
-- ## Pre-existing duplicates
--
--   SELECT driver_id, count(*) FROM vehicle_assignments
--   WHERE status = 'ACTIVE' GROUP BY driver_id HAVING count(*) > 1;
--
--   SELECT vehicle_id, count(*) FROM vehicle_assignments
--   WHERE status = 'ACTIVE' GROUP BY vehicle_id HAVING count(*) > 1;
--
-- On a database where this table has never been written to (its state before
-- this change), both return nothing.
--
-- Plain build, not CONCURRENTLY, for the same reason every other partial
-- unique index in this codebase records: Prisma wraps migrations in a
-- transaction, and CONCURRENTLY cannot run inside one.

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_assignments_active_driver_key"
  ON "vehicle_assignments" ("driver_id")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_assignments_active_vehicle_key"
  ON "vehicle_assignments" ("vehicle_id")
  WHERE "status" = 'ACTIVE';
