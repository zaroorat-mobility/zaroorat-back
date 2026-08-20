import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';

import { healthQueryOptions, isApiError } from '../api/index.ts';
import { navigation } from '../app/router/index.tsx';
import { logout, useAuth } from '../auth/index.ts';
import { useUser } from '../user/index.ts';
import type { ConnectionStatus } from '../components/ui/ConnectionIndicator.tsx';
import { ConnectionIndicator } from '../components/ui/ConnectionIndicator.tsx';
import { env } from '../config/env.ts';

function SessionControls() {
  const { status, busy } = useAuth();
  const user = useUser();
  const navigate = useNavigate();

  if (status === 'anonymous') {
    return (
      <NavLink to="/auth" className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800">
        Sign in
      </NavLink>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-slate-400">{user.data?.phoneNumber ?? 'authenticated'}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          await logout();
          void navigate('/auth');
        }}
        className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-50"
      >
        Sign out
      </button>
    </div>
  );
}

export function AppLayout() {
  const health = useQuery(healthQueryOptions);
  const { status } = useAuth();

  const connection: ConnectionStatus = health.isPending
    ? 'checking'
    : health.isSuccess
      ? 'connected'
      : 'unavailable';

  const detail = isApiError(health.error)
    ? `${health.error.code}: ${health.error.message}`
    : health.data
      ? `${health.data.environment} · up ${Math.round(health.data.uptime)}s`
      : undefined;

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-200 antialiased">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span className="font-semibold tracking-tight text-slate-100">Ride Platform</span>
          <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-400">
            demo console
          </span>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <code className="hidden text-slate-500 sm:block">{env.apiBaseUrl}</code>
            <SessionControls />
            <ConnectionIndicator status={connection} title={detail} />
          </div>
        </div>
      </header>

      {/* Sidebar on md+, horizontal scroller on small screens. */}
      <div className="md:grid md:grid-cols-[13rem_1fr]">
        <nav className="border-b border-slate-800 md:sticky md:top-[57px] md:h-[calc(100dvh-57px)] md:border-r md:border-b-0">
          <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-x-visible">
            {navigation.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                      isActive
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                    }`
                  }
                >
                  {item.label}
                  {item.protected && status !== 'authenticated' && (
                    <span className="text-[10px] text-slate-600" title="Requires authentication">
                      ●
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="p-4 md:p-6">
          {status === 'initializing' ? (
            <p className="text-sm text-slate-500">Initializing authentication…</p>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
