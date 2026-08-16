import { useState } from 'react';

import { useFileUrl } from '../../files/index.ts';
import type { Gender } from '../api/user.types.ts';
import { DefaultAvatar } from './DefaultAvatar.tsx';

/**
 * The uploaded photo when there is one, the illustrated default otherwise.
 *
 * The default also stands in while the presigned URL is being fetched and if
 * the image itself fails to load, so there is never an empty box or a broken
 * image icon.
 */
export function Avatar({
  fileId,
  gender,
  seed,
  size = 96,
  className = '',
}: {
  fileId: string | null;
  gender: Gender | null;
  seed?: string;
  size?: number;
  className?: string;
}) {
  const { data } = useFileUrl(fileId);
  const [failed, setFailed] = useState(false);

  const shell = `overflow-hidden rounded-full border border-slate-700 bg-slate-800 ${className}`;

  if (!fileId || failed || !data) {
    return (
      <div className={shell} style={{ width: size, height: size }}>
        <DefaultAvatar gender={gender} seed={seed ?? ''} className="h-full w-full" />
      </div>
    );
  }

  return (
    <div className={shell} style={{ width: size, height: size }}>
      <img
        src={data.url}
        alt="Profile photo"
        width={size}
        height={size}
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
