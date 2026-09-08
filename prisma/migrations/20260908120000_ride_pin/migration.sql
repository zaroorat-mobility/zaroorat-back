-- Phase 1 of the static 4-digit customer Ride PIN
-- (docs/RAPIDO_STYLE_STATIC_4_DIGIT_RIDE_PIN_PRODUCTION_SPEC.md §8).
--
-- Purely additive and nullable, with no read path in the application yet: the
-- previous application version never selects these columns, and the ride-start
-- path still verifies the per-ride OTP in `ride_otps`. That is deliberate — the
-- PIN columns are populated by riders over Phase 2 while the OTP remains the
-- credential, so the cutover in Phase 4 lands on an already-adopted PIN rather
-- than on an empty column.
--
-- ## Placement
--
-- On `users`, beside `password_hash`, rather than on `user_profiles`. Both are
-- credentials, and `user_profiles` is projected wholesale into `GET /users/me`
-- responses, so a verifier there is one careless `select` away from being
-- returned to a client. `users` is only ever projected field by field.
--
-- ## No unique constraint, no index
--
-- Not unique, on purpose: two riders both choosing 4827 is expected and valid.
-- Verification asks "is this the PIN of the customer who owns this ride", never
-- "is this PIN valid", so a collision means nothing. A unique index would break
-- the product AND leak which PINs are taken.
--
-- Not indexed either: the column is only ever read by `users.id`, which is
-- already the primary key. An index over a credential column would buy nothing
-- and would put credential material into another on-disk structure.
--
-- ## What the verifier is
--
-- `scrypt$N$r$p$salt$derived` over an HMAC of the PIN under a dedicated pepper
-- (see `hashRidePin`). NOT the unsalted HMAC the ride OTP uses: a 4-digit PIN
-- has only 10,000 values, so an unsalted digest lets anyone holding a database
-- dump bucket rows by identical verifier and read off the most common PINs by
-- frequency alone, with no secret required. The per-record salt makes identical
-- PINs store differently; scrypt makes the surviving offline attack expensive.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "ride_pin_verifier" TEXT,
  ADD COLUMN IF NOT EXISTS "ride_pin_updated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ride_pin_version" SMALLINT NOT NULL DEFAULT 0;

-- A forgotten PIN is reset by proving control of the registered number. That
-- challenge needs its own purpose so the code cannot be replayed against login
-- or against a phone change — the OTP secret lives under a purpose-scoped Redis
-- key, and `assertChallengeBelongsToCaller` compares the purpose.
--
-- Same shape as 20260731000000_add_phone_change_otp_purpose, for the same
-- reason. `ADD VALUE IF NOT EXISTS` is idempotent and safe to re-run.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'RIDE_PIN_RESET';
