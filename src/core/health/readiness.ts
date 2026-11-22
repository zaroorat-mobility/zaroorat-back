export interface ReadinessCheck {
  name: string;
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
export function registerReadinessCheck(check: ReadinessCheck): void {
  registry.set(check.name, check);
}
/// One-way latch set on SIGTERM. Readiness answers 503 from then on, so a load
/// balancer stops routing here while the server is still up to finish what it
/// already accepted — closing first would refuse those requests instead.
let draining = false;
export function markDraining(): void {
  draining = true;
}

export function clearReadinessChecks(): void {
  registry.clear();
  draining = false;
}
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
    if (timer) clearTimeout(timer);
  }
}
export async function runReadinessChecks(): Promise<ReadinessReport> {
  if (draining)
    return { ready: false, checks: [{ name: 'draining', ok: false, error: 'shutting down' }] };
  const checks = await Promise.all([...registry.values()].map(withTimeout));
  return { ready: checks.every((result) => result.ok), checks };
}
