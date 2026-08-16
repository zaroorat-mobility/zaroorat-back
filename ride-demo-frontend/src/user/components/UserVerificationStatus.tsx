/**
 * Reads the backend's booleans directly. Whether a phone or email is *present*
 * says nothing about whether it is verified, so the value is never inferred.
 */
export function UserVerificationStatus({ label, verified }: { label: string; verified: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className={verified ? 'text-emerald-400' : 'text-slate-400'}>
        {verified ? '✓ Verified' : 'Not verified'}
      </span>
    </div>
  );
}
