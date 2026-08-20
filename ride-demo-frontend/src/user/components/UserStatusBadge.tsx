import type { UserStatus } from '../api/user.types.ts';

/** The four values in prisma's UserStatus enum. */
const TONES: Record<UserStatus, string> = {
  ACTIVE: 'border-emerald-800 bg-emerald-950/60 text-emerald-300',
  UNVERIFIED: 'border-amber-800 bg-amber-950/60 text-amber-300',
  SUSPENDED: 'border-rose-800 bg-rose-950/60 text-rose-300',
  DEACTIVATED: 'border-slate-700 bg-slate-800/60 text-slate-400',
};

const UNKNOWN = 'border-slate-700 bg-slate-800/60 text-slate-300';

/** Renders any status the backend sends; an unrecognised one falls back to a
 *  neutral chip rather than crashing or rendering nothing. */
export function UserStatusBadge({ status }: { status: string }) {
  const tone = TONES[status as UserStatus] ?? UNKNOWN;
  return (
    <span className={`inline-block rounded border px-2 py-0.5 font-mono text-xs ${tone}`}>
      {status}
    </span>
  );
}
