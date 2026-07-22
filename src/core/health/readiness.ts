/**
 * Readiness check registry.
 *
 * Liveness (`/health`) answers "is the process alive". Readiness (`/ready`)
 * answers "can this instance serve traffic right now" — see
 * docs/03_OPERATIONS/DEPLOYMENT.md §6.
 *
 * Dependencies register themselves here as they are implemented, so the
 * orchestrator's probe URL never has to change. With no checks registered the
 * endpoint reports ready, which is correct: the app currently has no external
 * dependency it needs before it can answer requests.
 *
 * Milestone 2 registers `database` and `redis` from their bootstrap modules.
 */

export interface ReadinessCheck {
  name: string;
  /** Resolve when healthy; throw or reject when not. */
  probe: () => Promise<void> | void;
}

export interface ReadinessCheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheckResult[];
}

const registry = new Map<string, ReadinessCheck>();

/** Registering the same name twice replaces the previous probe. */
export function registerReadinessCheck(check: ReadinessCheck): void {
  registry.set(check.name, check);
}

export function clearReadinessChecks(): void {
  registry.clear();
}

/**
 * A probe that hangs would pin the whole endpoint open until the kubelet's own
 * timeout fires, turning one slow dependency into a failed rollout. Bound each.
 */
const PROBE_TIMEOUT_MS = 2000;

async function withTimeout(check: ReadinessCheck): Promise<ReadinessCheckResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      Promise.resolve(check.probe()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);

    return { name: check.name, ok: true };
  } catch (error) {
    return {
      name: check.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Without this the pending timer keeps the event loop alive and delays exit.
    if (timer) clearTimeout(timer);
  }
}

export async function runReadinessChecks(): Promise<ReadinessReport> {
  // Run in parallel: readiness latency should track the slowest dependency,
  // not the sum of all of them.
  const checks = await Promise.all([...registry.values()].map(withTimeout));

  return { ready: checks.every((result) => result.ok), checks };
}
