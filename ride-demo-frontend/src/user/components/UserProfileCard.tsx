import { formatDateOnly, formatDateTime } from '../../utils/format.ts';
import type { User } from '../api/user.types.ts';
import { Avatar } from './Avatar.tsx';
import { UserRoles } from './UserRoles.tsx';
import { UserStatusBadge } from './UserStatusBadge.tsx';
import { UserVerificationStatus } from './UserVerificationStatus.tsx';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 border-b border-slate-800/60 py-3 last:border-0">
      <dt className="text-xs tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function Empty({ children = 'Not provided' }: { children?: React.ReactNode }) {
  return <span className="text-slate-500 italic">{children}</span>;
}

/** Renders every field the backend returns; nothing is hidden when it is null. */
export function UserProfileCard({ user }: { user: User }) {
  const { profile } = user;
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Avatar
          fileId={profile.profileImageFileId}
          gender={profile.gender}
          seed={user.id}
          size={72}
        />
        <div className="min-w-0">
          <p className="truncate text-base text-slate-100">
            {fullName || <span className="text-slate-500 italic">No name set</span>}
          </p>
          <p className="truncate font-mono text-sm text-slate-400">{user.phoneNumber}</p>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Account</h2>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-4">
          <dl>
            <Field label="User ID">
              <code className="font-mono text-xs break-all text-slate-300">{user.id}</code>
            </Field>
            <Field label="Phone">
              <span className="font-mono">{user.phoneNumber}</span>
            </Field>
            <Field label="Email">{user.email ?? <Empty>No email on file</Empty>}</Field>
            <Field label="Account status">
              <UserStatusBadge status={user.status} />
            </Field>
            <Field label="Verification">
              <div className="max-w-xs space-y-1">
                <UserVerificationStatus label="Phone" verified={user.isPhoneVerified} />
                <UserVerificationStatus label="Email" verified={user.isEmailVerified} />
              </div>
            </Field>
            <Field label="Roles">
              <UserRoles roles={user.roles} />
            </Field>
            <Field label="Created">{formatDateTime(user.createdAt)}</Field>
            <Field label="Last login">
              {formatDateTime(user.lastLoginAt) ?? <Empty>Never</Empty>}
            </Field>
          </dl>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Profile</h2>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-4">
          <dl>
            <Field label="Full name">{fullName || <Empty />}</Field>
            <Field label="First name">{profile.firstName ?? <Empty />}</Field>
            <Field label="Last name">{profile.lastName ?? <Empty />}</Field>
            <Field label="Date of birth">{formatDateOnly(profile.dateOfBirth) ?? <Empty />}</Field>
            <Field label="Gender">{profile.gender ?? <Empty />}</Field>
            <Field label="Language">
              {profile.languageCode ?? <Empty>Not set</Empty>}
              {profile.languageCode === 'en' && (
                <span className="ml-2 text-xs text-slate-600">backend default</span>
              )}
            </Field>
            <Field label="Referral code">
              {profile.referralCode ? (
                <span className="font-mono">{profile.referralCode}</span>
              ) : (
                <Empty>None issued</Empty>
              )}
            </Field>
            <Field label="Profile image file ID">
              {profile.profileImageFileId ? (
                <code className="font-mono text-xs break-all text-slate-400">
                  {profile.profileImageFileId}
                </code>
              ) : (
                <Empty>No image uploaded</Empty>
              )}
            </Field>
          </dl>
        </div>
      </section>
    </div>
  );
}
