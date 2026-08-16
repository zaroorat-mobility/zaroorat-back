const STYLES = {
  checking: { dot: 'bg-amber-500', label: 'Checking' },
  connected: { dot: 'bg-emerald-500', label: 'Connected' },
  unavailable: { dot: 'bg-rose-500', label: 'Unavailable' },
} as const;

export type ConnectionStatus = keyof typeof STYLES;

/**
 * Presentational only — the caller runs the health query and passes the result
 * down. This component never talks to the API layer.
 */
export function ConnectionIndicator({
  status,
  title,
}: {
  status: ConnectionStatus;
  title?: string;
}) {
  const { dot, label } = STYLES[status];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-xs text-slate-300"
    >
      <span
        className={`size-2 rounded-full ${dot} ${status === 'checking' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      Backend: {label}
    </span>
  );
}
