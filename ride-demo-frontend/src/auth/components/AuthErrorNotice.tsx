import type { AuthErrorSummary } from '../auth.types.ts';
import { useCountdown } from '../hooks/useCountdown.ts';

/**
 * Renders only what the backend actually sent: its code, its message, its
 * per-field issues and its retry window. No invented copy, no guessed causes.
 */
export function AuthErrorNotice({ error }: { error: AuthErrorSummary | null }) {
  const retryAt = error?.retryAfterSec ? Date.now() + error.retryAfterSec * 1000 : null;
  const retryIn = useCountdown(retryAt);

  if (!error) return null;

  return (
    <div
      role="alert"
      className="space-y-2 rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm"
    >
      <div className="flex items-baseline gap-2">
        <code className="rounded bg-rose-900/60 px-1.5 py-0.5 text-xs text-rose-200">
          {error.status || 'ERR'} {error.code}
        </code>
        <span className="text-rose-100">{error.message}</span>
      </div>

      {error.fieldErrors.length > 0 && (
        <ul className="list-inside list-disc text-xs text-rose-200/90">
          {error.fieldErrors.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              <span className="font-mono">{issue.path || '(body)'}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}

      {retryIn > 0 && <p className="text-xs text-rose-200/90">Retry available in {retryIn}s.</p>}

      {error.requestId && (
        <p className="font-mono text-[11px] text-rose-300/70">request {error.requestId}</p>
      )}
    </div>
  );
}
