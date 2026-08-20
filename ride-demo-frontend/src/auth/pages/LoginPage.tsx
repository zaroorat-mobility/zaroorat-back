import { Navigate } from 'react-router';

import { healthQueryOptions } from '../../api/index.ts';
import { env } from '../../config/env.ts';
import { LoginForm } from '../components/LoginForm.tsx';
import { useAuth } from '../hooks/useAuth.ts';
import { useQuery } from '@tanstack/react-query';

export function LoginPage() {
  const { status } = useAuth();
  const health = useQuery(healthQueryOptions);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Authentication</h1>
        <p className="mt-1 text-sm text-slate-400">
          The backend authenticates by OTP only. A new phone number is registered on first
          verification.
        </p>
      </div>

      <LoginForm />

      <dl className="space-y-1 border-t border-slate-800 pt-4 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Backend</dt>
          <dd className={health.isSuccess ? 'text-emerald-400' : 'text-rose-400'}>
            {health.isPending ? 'Checking' : health.isSuccess ? 'Connected' : 'Unavailable'}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">API</dt>
          <dd className="truncate font-mono text-slate-400">{env.apiBaseUrl}</dd>
        </div>
      </dl>
    </section>
  );
}
