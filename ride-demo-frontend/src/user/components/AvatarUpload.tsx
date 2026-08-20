import { useRef, useState } from 'react';

import { PROFILE_IMAGE_POLICY, uploadErrorMessage, uploadProfileImage } from '../../files/index.ts';
import type { UploadStage } from '../../files/index.ts';
import type { User } from '../api/user.types.ts';
import { useUpdateProfile } from '../hooks/useUpdateProfile.ts';
import { Avatar } from './Avatar.tsx';

const STAGE_LABEL: Record<UploadStage, string> = {
  validating: 'Checking the image…',
  reserving: 'Reserving an upload slot…',
  transferring: 'Uploading…',
  verifying: 'Verifying…',
};

/**
 * Upload, replace or remove the profile photo.
 *
 * The upload is three real steps (reserve → PUT to storage → verify), and only
 * once the backend has marked the file READY is it attached to the profile —
 * so a failed transfer never leaves a dangling reference.
 */
export function AvatarUpload({ user }: { user: User }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateProfile = useUpdateProfile();

  const busy = stage !== null || updateProfile.isPending;

  async function handleFile(file: File) {
    setError(null);
    try {
      const uploaded = await uploadProfileImage(file, setStage);
      setStage(null);
      // Attach only after the backend has verified the object. The backend
      // supersedes the previous image and releases it for retention.
      await updateProfile.mutateAsync({ profileImageFileId: uploaded.fileId });
    } catch (cause) {
      setError(uploadErrorMessage(cause));
    } finally {
      setStage(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      await updateProfile.mutateAsync({ profileImageFileId: null });
    } catch (cause) {
      setError(uploadErrorMessage(cause));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar
        fileId={user.profile.profileImageFileId}
        gender={user.profile.gender}
        seed={user.id}
        size={88}
      />

      <div className="space-y-2">
        <input
          ref={inputRef}
          type="file"
          accept={PROFILE_IMAGE_POLICY.mimeTypes.join(',')}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {user.profile.profileImageFileId ? 'Replace photo' : 'Upload photo'}
          </button>

          {user.profile.profileImageFileId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRemove()}
              className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>

        <p className="text-xs text-slate-500">
          JPEG, PNG or WebP · up to 5 MB · max {PROFILE_IMAGE_POLICY.maxPixels.width}×
          {PROFILE_IMAGE_POLICY.maxPixels.height}
        </p>

        {busy && (
          <p className="text-xs text-sky-400">
            {stage ? STAGE_LABEL[stage] : 'Saving to your profile…'}
          </p>
        )}

        {error && (
          <p role="alert" className="max-w-sm text-xs text-rose-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
