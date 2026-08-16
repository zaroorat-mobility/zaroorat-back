import { Navigate } from 'react-router';

import { clearChallenge } from '../auth.store.ts';
import { OtpForm } from '../components/OtpForm.tsx';
import { useAuth } from '../hooks/useAuth.ts';

export function OtpVerificationPage() {
  const { status, challenge } = useAuth();

  if (status === 'authenticated') return <Navigate to="/" replace />;
  // Reached directly, without a challenge to verify against.
  if (!challenge) return <Navigate to="/auth" replace />;

  return (
    <section className="mx-auto max-w-sm space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">OTP Verification</h1>

      <OtpForm />

      <button
        type="button"
        onClick={clearChallenge}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        ← Use a different number
      </button>
    </section>
  );
}
