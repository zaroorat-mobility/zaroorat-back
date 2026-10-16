import { validatedEnv } from '../env/validated-env.js';
export const serverConfig = Object.freeze({
  host: validatedEnv.HOST,
  port: validatedEnv.PORT,
  /// On SIGTERM, /ready answers 503 for this long before anything closes, so a
  /// load balancer deregisters the instance first. Must cover its health-check
  /// interval x unhealthy threshold. 0 in development/test: no balancer, and a
  /// watch-mode restart should be instant.
  shutdownDrainMs: Number(
    process.env.API_SHUTDOWN_DRAIN_MS ??
      (validatedEnv.APP_ENV === 'development' || validatedEnv.APP_ENV === 'test' ? 0 : 10_000),
  ),
  /// Hard deadline for the whole shutdown, drain included. Keep it below the
  /// orchestrator's kill timeout (compose `stop_grace_period: 30s`) so the exit
  /// is ours, logged, rather than a SIGKILL.
  shutdownGraceMs: Number(process.env.API_SHUTDOWN_GRACE_MS ?? 25_000),
});
