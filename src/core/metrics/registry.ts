export const SAFE_LABELS: readonly string[] = Object.freeze([
  'reason',
  'provider',
  'gateway',
  'purpose',
  'status',
  'scope',
  'result',
  'event_type',
  'queue',
  'job',
  'cancelled_by',
  'method',
  'route',
  'code',
]);

type LabelValues = Record<string, string>;

interface Series {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  values: Map<string, { labels: LabelValues; value: number }>;
}

const series = new Map<string, Series>();

function safeLabels(fields?: Record<string, unknown>): LabelValues {
  if (!fields) return {};
  const out: LabelValues = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_LABELS.includes(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function labelKey(labels: LabelValues): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
}

function upsert(
  name: string,
  type: 'counter' | 'gauge',
  help: string,
  fields: Record<string, unknown> | undefined,
  apply: (previous: number) => number,
): void {
  let entry = series.get(name);
  if (!entry) {
    entry = { name, help, type, values: new Map() };
    series.set(name, entry);
  }

  const labels = safeLabels(fields);
  const key = labelKey(labels);
  const previous = entry.values.get(key)?.value ?? 0;
  entry.values.set(key, { labels, value: apply(previous) });
}

export function incrementCounter(name: string, fields?: Record<string, unknown>, by = 1): void {
  upsert(name, 'counter', `${name} total`, fields, (previous) => previous + by);
}

export function setGauge(name: string, value: number, fields?: Record<string, unknown>): void {
  upsert(name, 'gauge', `${name} current value`, fields, () => value);
}

export function resetMetrics(): void {
  series.clear();
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Render every series in the Prometheus text exposition format (v0.0.4). */
export function renderMetrics(): string {
  const lines: string[] = [];

  for (const entry of [...series.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`# HELP ${entry.name} ${entry.help}`);
    lines.push(`# TYPE ${entry.name} ${entry.type}`);
    for (const { labels, value } of entry.values.values()) {
      const rendered = Object.keys(labels)
        .sort()
        .map((key) => `${key}="${escapeLabelValue(labels[key] as string)}"`)
        .join(',');
      lines.push(rendered ? `${entry.name}{${rendered}} ${value}` : `${entry.name} ${value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function collectProcessMetrics(): void {
  const memory = process.memoryUsage();
  setGauge('process_resident_memory_bytes', memory.rss);
  setGauge('nodejs_heap_used_bytes', memory.heapUsed);
  setGauge('nodejs_heap_total_bytes', memory.heapTotal);
  setGauge('process_uptime_seconds', Math.round(process.uptime()));
}
