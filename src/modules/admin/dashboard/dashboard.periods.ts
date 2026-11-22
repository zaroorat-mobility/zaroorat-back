/**
 * Reporting periods for the operations dashboard.
 *
 * Business dates are Asia/Kolkata days. IST has a fixed +05:30 offset and no
 * daylight saving, so "24 hours ago" is always the same wall-clock time on the
 * previous IST day.
 */

export const REPORTING_TIME_ZONE = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ComparisonWindows {
  /** IST midnight at the start of today */
  todayStart: Date;
  /** IST midnight at the start of tomorrow */
  tomorrowStart: Date;
  /** IST midnight at the start of yesterday */
  yesterdayStart: Date;
  /** The instant being reported: today's window is [todayStart, now) */
  now: Date;
  /**
   * Yesterday at the same IST time of day as `now`. The comparison window is
   * [yesterdayStart, sameTimeYesterday), the same elapsed length as today's,
   * so a partial day is never compared with a complete one.
   */
  sameTimeYesterday: Date;
}

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function comparisonWindows(now: Date): ComparisonWindows {
  const todayStart = new Date(`${istDateKey(now)}T00:00:00+05:30`);
  return {
    todayStart,
    tomorrowStart: new Date(todayStart.getTime() + DAY_MS),
    yesterdayStart: new Date(todayStart.getTime() - DAY_MS),
    now,
    sameTimeYesterday: new Date(now.getTime() - DAY_MS),
  };
}
