/// Reading a tuning knob out of the environment.
///
/// `Number(process.env.X ?? default)` is the pattern the config modules grew up
/// with, and it fails silently in the two ways that matter: a typo yields `NaN`,
/// and `NaN` then defeats every guard downstream, because every comparison
/// against it is false. `RIDE_DISPATCH_BATCH_SIZE=3x` was enough to make the
/// dispatcher's `slots <= 0` check pass and its `candidates.length >= limit`
/// break never fire — offering a ride to every driver in range instead of three.
///
/// So a bad value stops the process at import time, the same way
/// `validateEnvironment` already stops it for a missing DATABASE_URL. A
/// mistyped knob is a deployment error; discovering it at boot is far cheaper
/// than discovering it from a driver's phone.
export function numericEnv(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);

  const problem = describeProblem(value, bounds);
  if (problem) {
    // Thrown, not `process.exit`: config is imported by tests and tooling too,
    // and a throw is catchable and reportable where a bare exit is neither.
    throw new Error(
      `Invalid configuration: ${name}=${JSON.stringify(raw)} — ${problem}. ` +
        `Remove it to use the default (${fallback}).`,
    );
  }
  return value;
}

function describeProblem(
  value: number,
  bounds: { min?: number; max?: number; integer?: boolean },
): string | null {
  if (!Number.isFinite(value)) return 'expected a finite number';
  if (bounds.integer && !Number.isInteger(value)) return 'expected a whole number';
  if (bounds.min !== undefined && value < bounds.min) return `must be at least ${bounds.min}`;
  if (bounds.max !== undefined && value > bounds.max) return `must be at most ${bounds.max}`;
  return null;
}
