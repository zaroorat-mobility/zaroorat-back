-- FR-044. Code lookups that an index can actually answer.
--
-- Every promo validation normalised the code to uppercase and then still queried
-- with `mode: 'insensitive'`, which Postgres serves as ILIKE. The unique btree on
-- `code` could not be used, so validating a promo meant a sequential scan of a
-- table that coupon generation is designed to grow into the millions.
--
-- A unique index on upper(code) serves the case-insensitive lookup directly, and
-- doubles as the constraint that stops 'SAVE20' and 'save20' both existing.
--
-- Pre-flight (constitution 3.5) — must return 0 for each before deploy:
--   SELECT count(*) FROM (SELECT upper(code) FROM promotions     GROUP BY 1 HAVING count(*)>1) d;
--   SELECT count(*) FROM (SELECT upper(code) FROM coupons        GROUP BY 1 HAVING count(*)>1) d;
--   SELECT count(*) FROM (SELECT upper(code) FROM referral_codes GROUP BY 1 HAVING count(*)>1) d;
--
-- On a large `coupons` table build these with CREATE UNIQUE INDEX CONCURRENTLY
-- before `migrate deploy`; the IF NOT EXISTS below then makes this a no-op.
-- CONCURRENTLY cannot run inside Prisma's migration transaction.
CREATE UNIQUE INDEX IF NOT EXISTS "promotions_code_upper_key"
  ON "promotions" (upper("code"));

CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_upper_key"
  ON "coupons" (upper("code"));

CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_code_upper_key"
  ON "referral_codes" (upper("code"));
