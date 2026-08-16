import type { Gender } from '../api/user.types.ts';

/**
 * Illustrated fallback avatars, drawn inline as SVG — no image requests, no
 * dependency, crisp at any size, and they work before any upload exists.
 *
 * The silhouette comes from `gender`; MALE and FEMALE get distinct hair, and
 * everything else (OTHER, PREFER_NOT_TO_SAY, not set) gets a neutral figure
 * rather than being forced into one of the two.
 *
 * The hue is derived from the user id, so two people with the same gender do
 * not get identical avatars.
 */

const PALETTES = [
  { from: '#0ea5e9', to: '#0369a1', skin: '#f2c9a0', hair: '#3f2a1d' },
  { from: '#8b5cf6', to: '#5b21b6', skin: '#e8b58c', hair: '#1f2937' },
  { from: '#10b981', to: '#065f46', skin: '#f7d7b8', hair: '#4b2e14' },
  { from: '#f59e0b', to: '#b45309', skin: '#d9a273', hair: '#20160f' },
  { from: '#ec4899', to: '#9d174d', skin: '#f4cdae', hair: '#2d1b12' },
  { from: '#06b6d4', to: '#155e75', skin: '#c98f68', hair: '#171717' },
];

function paletteFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[hash % PALETTES.length] as (typeof PALETTES)[number];
}

export function DefaultAvatar({
  gender,
  seed = '',
  className,
}: {
  gender: Gender | null;
  seed?: string;
  className?: string;
}) {
  const { from, to, skin, hair } = paletteFor(seed);
  const gradientId = `av-${(seed || 'anon').replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'anon'}`;

  const label =
    gender === 'MALE'
      ? 'Default avatar, masculine'
      : gender === 'FEMALE'
        ? 'Default avatar, feminine'
        : 'Default avatar';

  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
        <clipPath id={`${gradientId}-clip`}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${gradientId}-clip)`}>
        <circle cx="50" cy="50" r="50" fill={`url(#${gradientId})`} />

        {gender === 'FEMALE' ? (
          <>
            {/* hair behind, falling past the shoulders */}
            <path
              d="M25 46c0-17 11-27 25-27s25 10 25 27c0 12-2 20-5 27H30c-3-7-5-15-5-27z"
              fill={hair}
            />
            <path d="M50 96c-14 0-25 7-28 14h56c-3-7-14-14-28-14z" fill="#f8fafc" opacity=".92" />
            <path d="M42 62h16v12a8 8 0 0 1-16 0z" fill={skin} />
            <circle cx="50" cy="47" r="19" fill={skin} />
            {/* fringe */}
            <path d="M31 45c1-12 9-19 19-19s18 7 19 19c-4-6-11-9-19-9s-15 3-19 9z" fill={hair} />
          </>
        ) : gender === 'MALE' ? (
          <>
            <path d="M50 96c-14 0-25 7-28 14h56c-3-7-14-14-28-14z" fill="#f8fafc" opacity=".92" />
            <path d="M42 62h16v12a8 8 0 0 1-16 0z" fill={skin} />
            <circle cx="50" cy="47" r="19" fill={skin} />
            {/* short cropped hair */}
            <path
              d="M31 44c0-11 9-18 19-18s19 7 19 18c0 2-1 3-2 3-2-7-9-11-17-11s-15 4-17 11c-1 0-2-1-2-3z"
              fill={hair}
            />
          </>
        ) : (
          <>
            {/* neutral: no gendered hair silhouette */}
            <path d="M50 96c-14 0-25 7-28 14h56c-3-7-14-14-28-14z" fill="#f8fafc" opacity=".92" />
            <path d="M42 62h16v12a8 8 0 0 1-16 0z" fill={skin} />
            <circle cx="50" cy="47" r="19" fill={skin} />
            <path
              d="M32 46a18 18 0 0 1 36 0c0 1-1 2-2 2a16 16 0 0 0-32 0c-1 0-2-1-2-2z"
              fill={hair}
            />
          </>
        )}
      </g>
    </svg>
  );
}
