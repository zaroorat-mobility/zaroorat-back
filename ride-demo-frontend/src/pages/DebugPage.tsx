import { useAuth } from '../auth/index.ts';
import { env } from '../config/env.ts';
import { useUser } from '../user/index.ts';
import { maskPhoneNumber } from '../utils/format.ts';

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800/60 py-1.5 last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`truncate text-right font-mono ${tone ?? 'text-slate-300'}`}>{value}</dd>
    </div>
  );
}

/**
 * Developer diagnostics. Shows only whether credentials exist, never their
 * value — the auth store keeps tokens out of its published snapshot entirely,
 * so there is no path from here to one. The phone number is masked.
 */
export function DebugPage() {
  const auth = useAuth();
  const user = useUser();

  const expiresIn = auth.accessTokenExpiresAt
    ? Math.max(0, Math.round((auth.accessTokenExpiresAt - Date.now()) / 1000))
    : null;

  const userState =
    auth.status !== 'authenticated'
      ? 'Idle (anonymous)'
      : user.isPending
        ? 'Loading'
        : user.isError
          ? 'Failed'
          : 'Loaded';

  return (
    <section className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Debug</h1>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Authentication</h2>
        <dl className="rounded border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs">
          <Row
            label="Status"
            value={auth.status}
            tone={auth.status === 'authenticated' ? 'text-emerald-400' : 'text-amber-400'}
          />
          <Row
            label="Access token"
            value={auth.hasAccessToken ? '********present********' : 'Missing'}
            tone={auth.hasAccessToken ? 'text-emerald-400' : 'text-slate-500'}
          />
          <Row label="Access token expires in" value={expiresIn === null ? '—' : `${expiresIn}s`} />
          <Row
            label="Refresh"
            value={auth.hasRefreshToken ? 'Available' : 'Not available'}
            tone={auth.hasRefreshToken ? 'text-emerald-400' : 'text-slate-500'}
          />
          <Row label="Last operation" value={auth.lastOperation ?? '—'} />
        </dl>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Authenticated user</h2>
        <dl className="rounded border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs">
          <Row label="Query" value={userState} />
          <Row label="User ID" value={user.data?.id ?? auth.userId ?? '—'} />
          <Row
            label="Account status"
            value={user.data?.status ?? auth.accountStatus ?? '—'}
            tone={user.data?.status === 'ACTIVE' ? 'text-emerald-400' : undefined}
          />
          <Row label="Roles" value={(user.data?.roles ?? auth.roles).join(', ') || '—'} />
          <Row label="Phone" value={user.data ? maskPhoneNumber(user.data.phoneNumber) : '—'} />
          <Row label="Phone verified" value={user.data ? String(user.data.isPhoneVerified) : '—'} />
          <Row label="Email verified" value={user.data ? String(user.data.isEmailVerified) : '—'} />
          <Row
            label="Profile"
            value={
              user.data
                ? user.data.profile.firstName || user.data.profile.lastName
                  ? 'Loaded (has detail)'
                  : 'Loaded (empty)'
                : '—'
            }
          />
        </dl>
      </div>

      {(auth.lastError || user.error) && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">Last error</h2>
          <dl className="rounded border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs">
            {auth.lastError && (
              <>
                <Row label="Source" value="auth" />
                <Row label="Status" value={String(auth.lastError.status)} />
                <Row label="Code" value={auth.lastError.code} tone="text-rose-400" />
                <Row label="Message" value={auth.lastError.message} />
                <Row label="Request ID" value={auth.lastError.requestId ?? '—'} />
                <Row
                  label="Retry after"
                  value={auth.lastError.retryAfterSec ? `${auth.lastError.retryAfterSec}s` : '—'}
                />
              </>
            )}
            {user.error && (
              <Row label="User query" value={user.error.message} tone="text-rose-400" />
            )}
          </dl>
        </div>
      )}

      {user.data && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">GET /api/v1/users/me</h2>
          <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-300">
            {JSON.stringify(user.data, null, 2)}
          </pre>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Environment</h2>
        <dl className="rounded border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs">
          <Row label="API base URL" value={env.apiBaseUrl} />
          <Row label="Socket URL" value={env.socketUrl} />
          <Row label="Mode" value={env.isDev ? 'development' : 'production'} />
        </dl>
      </div>
    </section>
  );
}
