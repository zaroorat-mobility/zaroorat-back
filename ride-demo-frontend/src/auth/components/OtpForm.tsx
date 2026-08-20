import { useState } from 'react';
import { useNavigate } from 'react-router';

import { requestOtp, verifyOtp } from '../auth.store.ts';
import { useAuth } from '../hooks/useAuth.ts';
import { useCountdown } from '../hooks/useCountdown.ts';
import { AuthErrorNotice } from './AuthErrorNotice.tsx';

/**
 * Step 2: the code goes to the backend untouched. The code itself is never
 * shown, pre-filled or bypassed here — in development the backend's mock SMS
 * provider logs it server-side, which is the only place to read it.
 */
export function OtpForm() {
  const { busy, lastError, challenge } = useAuth();
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  const expiresIn = useCountdown(challenge?.expiresAt ?? null);
  const resendIn = useCountdown(challenge?.resendAvailableAt ?? null);

  if (!challenge) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (await verifyOtp(code.trim())) {
      void navigate('/');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-slate-400">
        Enter the OTP the backend sent to{' '}
        <span className="font-mono text-slate-200">{challenge.phoneNumber}</span>.
      </p>

      <div className="space-y-1.5">
        <label htmlFor="code" className="block text-sm text-slate-300">
          OTP
        </label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          placeholder="000000"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-lg tracking-[0.4em] text-slate-100 outline-none focus:border-sky-600"
        />
        <p className="text-xs text-slate-500">
          {expiresIn > 0 ? `Code expires in ${expiresIn}s.` : 'Code expired — request a new one.'}
        </p>
      </div>

      <AuthErrorNotice error={lastError} />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="flex-1 rounded bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          disabled={busy || resendIn > 0}
          onClick={() => void requestOtp(challenge.phoneNumber)}
          className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend'}
        </button>
      </div>
    </form>
  );
}
