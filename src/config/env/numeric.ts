export function numericEnv(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);

  const problem = describeProblem(value, bounds);
  if (problem) {
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
