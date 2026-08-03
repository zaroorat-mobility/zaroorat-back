-- Phone-number change (user doc 02 §2.4) needs its own OTP purpose so the code
-- proving control of a new number cannot be replayed against the login flow —
-- the OTP secret lives under a purpose-scoped Redis key.
--
-- user doc 03 §5 enumerates the v1 database work but does not list this enum
-- value; it is required by doc 02 §2.4.1 and ships here.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'PHONE_CHANGE';
