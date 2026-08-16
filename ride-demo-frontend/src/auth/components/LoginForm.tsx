import { useState } from 'react';
import { useNavigate } from 'react-router';

import { requestOtp } from '../auth.store.ts';
import { useAuth } from '../hooks/useAuth.ts';
import { AuthErrorNotice } from './AuthErrorNotice.tsx';

/**
 * Step 1 of the only login the backend has: phone number in, OTP out. There is
 * no password field because there is no password — /otp/verify both signs in
 * and creates the account.
 */
export function LoginForm() {
  const { busy, lastError } = useAuth();
  const [phoneNumber, setPhoneNumber] = useState('');
  const navigate = useNavigate();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (await requestOtp(phoneNumber.trim())) {
      void navigate('/auth/otp');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="phoneNumber" className="block text-sm text-slate-300">
          Phone number
        </label>
        <input
          id="phoneNumber"
          name="phoneNumber"
          type="tel"
          autoComplete="tel"
          required
          placeholder="+919876543210"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-sky-600"
        />
        <p className="text-xs text-slate-500">E.164 format, as the backend requires.</p>
      </div>

      <AuthErrorNotice error={lastError} />

      <button
        type="submit"
        disabled={busy || phoneNumber.trim().length === 0}
        className="w-full rounded bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Send OTP'}
      </button>
    </form>
  );
}
