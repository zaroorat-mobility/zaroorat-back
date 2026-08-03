-- The v1 USER schema work (user doc 03 §5): four objects doc 02 depends on that
-- are absent from `20260724173304_init`. Additive only — no column or type
-- changes — so this deploys in one step (doc 03 §7).
--
-- Doc 03 §7 asks for CONCURRENTLY in production. Prisma runs each migration in a
-- transaction and offers no supported way to opt out, and CONCURRENTLY cannot run
-- inside one. These tables are empty at v1, so a plain build is instant; a later
-- rebuild on populated tables must be done out-of-band.

-- 1. Ownership scoping (§4.3): every list/CRUD query filters on user_id.
CREATE INDEX IF NOT EXISTS "ix_emergency_contacts_user" ON "emergency_contacts" ("user_id");
CREATE INDEX IF NOT EXISTS "ix_saved_places_user" ON "saved_places" ("user_id");

-- 2. Saved-place labels are unique per user, case-insensitively (doc 02 §2.6 →
--    409 CONFLICT). Without this, "Home" and "home" both exist and the place
--    picker shows duplicates. This index IS the enforcement; the application
--    pre-check only exists to phrase the error.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_saved_places_user_label"
  ON "saved_places" ("user_id", lower("label"));

-- 3. Geospatial index. `location` exists but nothing can query it efficiently;
--    `rides`/`geo` need this the moment saved places reach the booking flow.
CREATE INDEX IF NOT EXISTS "ix_saved_places_location" ON "saved_places" USING GIST ("location");

-- 4. Emergency-contact notification order (R-USER-23) — `sos` reads by
--    (user, priority).
CREATE INDEX IF NOT EXISTS "ix_emergency_contacts_priority"
  ON "emergency_contacts" ("user_id", "priority");
