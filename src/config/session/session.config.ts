/**
 * Session policy (auth doc 02 §5.1).
 *
 * Concurrent-session caps (standard vs privileged admin/support) and the TTL for
 * per-`sid` denylist entries. The denylist TTL must be at least the access-token
 * lifetime so a revoked session cannot outlive its marker; it defaults to the
 * 15-minute access TTL.
 */
export const sessionConfig = Object.freeze({
  maxConcurrentSessions: Number(process.env.SESSION_MAX_CONCURRENT ?? 5),
  privilegedMaxConcurrentSessions: Number(process.env.SESSION_MAX_CONCURRENT_PRIVILEGED ?? 2),
  denylistTtlSeconds: Number(process.env.SESSION_DENYLIST_TTL ?? 900),
  /** Idle timeout — a session with no activity for this long is treated as
   *  expired even before its absolute lifetime. Enforced by the auth hook. */
  idleTimeoutSeconds: Number(process.env.SESSION_IDLE_TIMEOUT ?? 1_209_600),
});

export type SessionConfig = typeof sessionConfig;
