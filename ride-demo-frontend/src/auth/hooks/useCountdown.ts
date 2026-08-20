import { useEffect, useState } from 'react';

/** Whole seconds left until `targetEpochMs`, ticking to 0. Null target = 0. */
export function useCountdown(targetEpochMs: number | null): number {
  const remaining = () =>
    targetEpochMs ? Math.max(0, Math.ceil((targetEpochMs - Date.now()) / 1000)) : 0;

  const [seconds, setSeconds] = useState(remaining);

  useEffect(() => {
    setSeconds(remaining);
    if (!targetEpochMs) return;

    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((targetEpochMs - Date.now()) / 1000));
      setSeconds(left);
      if (left === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEpochMs]);

  return seconds;
}
