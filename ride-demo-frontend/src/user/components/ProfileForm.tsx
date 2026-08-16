import { useState } from 'react';

import { isApiError } from '../../api/index.ts';
import type { Gender, UpdateProfileRequest, User } from '../api/user.types.ts';
import { useUpdateProfile } from '../hooks/useUpdateProfile.ts';

/** `userConfig.genderValues` — a frozen literal in the backend, not env-driven. */
const GENDERS: Gender[] = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'];

/**
 * `userConfig.supportedLanguageCodes` defaults to en,hi but is env-configurable
 * and has no discovery endpoint, so the current value is always offered even if
 * it is not one of these. The backend rejects anything it does not support.
 */
const DEFAULT_LANGUAGES = ['en', 'hi'];

/** The users module answers with codes, not sentences. See ValidationIssue.code. */
const FIELD_ERRORS: Record<string, string> = {
  REQUIRED: 'Required',
  INVALID_FORMAT: 'Invalid format',
  TOO_LONG: 'Too long',
  OUT_OF_RANGE: 'Out of range',
  MUST_BE_PAST: 'Must be a date in the past',
  AGE_BELOW_MINIMUM: 'Below the minimum age the backend allows',
  NOT_ALLOWED: 'Not an accepted value',
  IMMUTABLE: 'This field cannot be changed here',
};

/**
 * `profileImageFileId` is editable on the backend but is not a text field here:
 * AvatarUpload owns it, so the id always refers to a file this user has
 * actually uploaded and the backend has verified.
 */
const EDITABLE = ['firstName', 'lastName', 'dateOfBirth', 'gender', 'languageCode'] as const;

type EditableField = (typeof EDITABLE)[number];

/** '' in a form field means "cleared", which the backend expresses as null. */
const toValue = (v: string | null) => v ?? '';
const toPayload = (v: string) => (v.trim() === '' ? null : v.trim());

export function ProfileForm({ user, onDone }: { user: User; onDone: () => void }) {
  const initial = Object.fromEntries(
    EDITABLE.map((field) => [field, toValue(user.profile[field])]),
  ) as Record<EditableField, string>;

  const [form, setForm] = useState(initial);
  const mutation = useUpdateProfile();

  const issues = isApiError(mutation.error) ? mutation.error.validationErrors : [];
  const errorFor = (field: string) => {
    const issue = issues.find((i) => i.path === field);
    if (!issue) return null;
    return FIELD_ERRORS[issue.code ?? ''] ?? issue.message;
  };

  // Only changed keys are sent: the update is partial, and including an
  // untouched field would rewrite it with the value we happen to be holding.
  const changed = EDITABLE.filter((field) => form[field] !== initial[field]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (changed.length === 0) return onDone();

    const body: UpdateProfileRequest = {};
    for (const field of changed) {
      const value = toPayload(form[field]);
      if (field === 'gender') body.gender = value as Gender | null;
      else body[field] = value;
    }
    mutation.mutate(body, { onSuccess: onDone });
  }

  const set = (field: EditableField) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const languages = DEFAULT_LANGUAGES.includes(form.languageCode)
    ? DEFAULT_LANGUAGES
    : [...DEFAULT_LANGUAGES, form.languageCode].filter(Boolean);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Text
          id="firstName"
          label="First name"
          value={form.firstName}
          onChange={set('firstName')}
          maxLength={64}
          error={errorFor('firstName')}
        />
        <Text
          id="lastName"
          label="Last name"
          value={form.lastName}
          onChange={set('lastName')}
          maxLength={64}
          error={errorFor('lastName')}
        />
        <Text
          id="dateOfBirth"
          label="Date of birth"
          type="date"
          value={form.dateOfBirth}
          onChange={set('dateOfBirth')}
          max={new Date().toISOString().slice(0, 10)}
          error={errorFor('dateOfBirth')}
        />
        <Select
          id="gender"
          label="Gender"
          value={form.gender}
          onChange={set('gender')}
          options={GENDERS}
          error={errorFor('gender')}
        />
        <Select
          id="languageCode"
          label="Language"
          value={form.languageCode}
          onChange={set('languageCode')}
          options={languages}
          error={errorFor('languageCode')}
        />
      </div>

      {mutation.isError && (
        <div
          role="alert"
          className="space-y-1 rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-sm"
        >
          <p className="text-rose-100">
            {isApiError(mutation.error) ? mutation.error.message : 'Could not save your profile.'}
          </p>
          {isApiError(mutation.error) && (
            <p className="font-mono text-[11px] text-rose-300/70">
              {mutation.error.status} {mutation.error.code}
              {mutation.error.requestId ? ` · request ${mutation.error.requestId}` : ''}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={mutation.isPending}
          className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <span className="text-xs text-slate-500">
          {changed.length === 0
            ? 'No changes'
            : `${changed.length} field${changed.length > 1 ? 's' : ''} changed`}
        </span>
      </div>
      <p className="text-xs text-slate-600">
        Clearing a field sends null, which removes the stored value.
      </p>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-slate-300">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

const inputClass = (error: string | null) =>
  `w-full rounded border bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-600 ${
    error ? 'border-rose-800' : 'border-slate-700'
  }`;

function Text({
  id,
  label,
  value,
  onChange,
  error,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>) {
  return (
    <Field id={id} label={label} error={error}>
      <input
        id={id}
        name={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass(error)}
        {...rest}
      />
    </Field>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  error: string | null;
}) {
  return (
    <Field id={id} label={label} error={error}>
      <select
        id={id}
        name={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass(error)}
      >
        <option value="">— Not set —</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  );
}
