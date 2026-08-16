export const sessionConfig = Object.freeze({
  maxConcurrentSessions: Number(process.env.SESSION_MAX_CONCURRENT ?? 5),
  privilegedMaxConcurrentSessions: Number(process.env.SESSION_MAX_CONCURRENT_PRIVILEGED ?? 2),
  denylistTtlSeconds: Number(process.env.SESSION_DENYLIST_TTL ?? 900),
  lastSeenThrottleSeconds: Number(process.env.SESSION_LAST_SEEN_THROTTLE ?? 60),
});
export type SessionConfig = typeof sessionConfig;
