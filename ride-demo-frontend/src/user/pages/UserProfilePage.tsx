import { useState } from 'react';

import { isApiError } from '../../api/index.ts';
import { AvatarUpload } from '../components/AvatarUpload.tsx';
import { ProfileForm } from '../components/ProfileForm.tsx';
import { UserProfileCard } from '../components/UserProfileCard.tsx';
import { useUser } from '../hooks/useUser.ts';

export function UserProfilePage() {
  // `isLoading`, not `isPending`: a disabled query (anonymous visitor) is
  // pending-but-idle forever, which would otherwise show a spinner that never
  // resolves. isLoading is pending AND actually in flight.
  const { data, isLoading, isError, error, refetch, isFetching } = useUser();
  const [editing, setEditing] = useState(false);

  return (
    <section className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-slate-100">My Profile</h1>
        {data && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Edit profile
          </button>
        )}
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading profile…</p>}

      {isError && (
        <div
          role="alert"
          className="space-y-2 rounded border border-rose-900 bg-rose-950/50 px-3 py-3 text-sm"
        >
          <p className="text-rose-100">Unable to load your profile.</p>
          {isApiError(error) && (
            <dl className="space-y-0.5 font-mono text-xs text-rose-200/90">
              <div>
                {error.status || 'ERR'} {error.code}
              </div>
              <div>{error.message}</div>
              {error.requestId && <div className="text-rose-300/70">request {error.requestId}</div>}
            </dl>
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded border border-rose-800 px-2 py-1 text-xs text-rose-100 hover:bg-rose-900/50 disabled:opacity-50"
          >
            {isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {data &&
        (editing ? (
          <div className="space-y-6">
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-slate-300">Photo</h2>
              <AvatarUpload user={data} />
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-medium text-slate-300">Details</h2>
              <p className="text-sm text-slate-400">
                Phone, email, status, roles and referral code are immutable here — the backend
                rejects them with <code className="font-mono">IMMUTABLE_FIELD</code>.
              </p>
              <ProfileForm user={data} onDone={() => setEditing(false)} />
            </section>
          </div>
        ) : (
          <UserProfileCard user={data} />
        ))}
    </section>
  );
}
