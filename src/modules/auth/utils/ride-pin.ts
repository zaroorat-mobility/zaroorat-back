import { createHmac } from 'node:crypto';
import { ridePinConfig } from '@config';
import { hashPassword, verifyPassword } from './password';

/// Storage and verification for the rider's standing 4-digit Ride PIN.
///
/// Deliberately NOT `OtpHasher`, which is the right primitive for the auth OTP
/// and the wrong one here. `OtpHasher` is a single unsalted HMAC; over a
/// four-digit keyspace that fails twice over:
///
///   1. Unsalted means every rider whose PIN is 4827 stores the *same* 64-char
///      string. Anyone holding a database dump groups rows by verifier and
///      reads the most common PINs straight off the histogram — no pepper, no
///      secret, no hashing work required at all.
///   2. One HMAC pass is microseconds, so a leaked pepper hands over all 10,000
///      candidates per rider instantly.
///
/// `hashPassword` fixes both: a fresh per-record salt makes identical PINs store
/// differently, and scrypt (N=16384) makes the surviving offline attack cost
/// real CPU per rider rather than per platform. The pepper on top means a
/// database-only compromise — a leaked backup, a read replica, an injection —
/// yields nothing attackable at all, because the attacker cannot even begin
/// without a secret that never leaves the application's environment.
///
/// Neither problem mattered for the ride OTP, which is worthless fifteen minutes
/// after it is minted. Both matter for a credential that stands for years.
function peppered(pin: string): string {
  return createHmac('sha256', ridePinConfig.pepper).update(pin).digest('hex');
}

export function hashRidePin(pin: string): string {
  return hashPassword(peppered(pin));
}

/// False for a rider who has no PIN configured, and — because `verifyPassword`
/// hashes a dummy value on that path — in the same time it takes to reject a
/// wrong one. Without that the ride-start endpoint would answer faster for
/// riders with no PIN, which tells a driver exactly whose account to target.
export function verifyRidePin(pin: string, verifier: string | null | undefined): boolean {
  return verifyPassword(peppered(pin), verifier);
}

/// `0000`-`9999`, as a string throughout. Never parsed as a number anywhere in
/// this flow: `Number('0827')` is 827, and a PIN that silently loses its leading
/// zero is a rider who can never start a ride again.
export function isWellFormedRidePin(pin: string): boolean {
  return new RegExp(`^[0-9]{${ridePinConfig.length}}$`).test(pin);
}

export function isBlockedRidePin(pin: string): boolean {
  return ridePinConfig.blocklist.has(pin);
}
