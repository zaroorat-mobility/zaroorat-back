/// FR-013. Is a wall-clock instant inside an operator's peak-hour window?
///
/// `SurgeWindow` carries `peakHourStart`, `peakHourEnd` and `isPeakHourOnly`.
/// `createSurgeWindowSchema` validates them — it even refines that both hours are
/// present when `isPeakHourOnly` is set — the service writes them, and the list
/// endpoint returns them. `resolveSurgeMultiplier` read only `multiplier`, so a
/// window configured as 1.8x for 08:00-10:00 multiplied fares at three in the
/// morning, every day, until `endsAt` passed.
///
/// That is worse than the feature not existing: the admin UI actively asserted a
/// constraint the pricing path ignored.
///
/// Pure and synchronous so it can be tested without a database or a clock stub.

/// Minutes since local midnight, or null if the value is not `HH:mm`.
/// The column is free text, so an operator can put anything in it; an
/// unparseable bound must not silently widen the window.
export function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/// Minutes since midnight for `at`, read in `timeZone`.
///
/// Peak hours are wall-clock in the city the ride starts in, not on the server.
/// `City.timezone` exists precisely so this is answerable; a server in UTC
/// pricing a Srinagar morning peak would otherwise be five and a half hours out.
export function minutesOfDayIn(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export interface PeakWindowSpec {
  isPeakHourOnly: boolean;
  peakHourStart: string | null;
  peakHourEnd: string | null;
}

/// Whether a window may contribute its multiplier at this instant.
///
/// A window that is not peak-hour-only always applies — the surge period itself
/// is already bounded by `startsAt`/`endsAt`.
///
/// A peak-hour-only window whose bounds cannot be parsed does NOT apply. Failing
/// closed here is the safe direction: the alternative is charging a surge
/// multiplier around the clock because someone typed "8am" into a text column.
export function isWithinPeakWindow(window: PeakWindowSpec, at: Date, timeZone: string): boolean {
  if (!window.isPeakHourOnly) return true;

  const start = parseHhMm(window.peakHourStart);
  const end = parseHhMm(window.peakHourEnd);
  if (start === null || end === null) return false;

  const now = minutesOfDayIn(at, timeZone);

  // A window that ends before it starts crosses midnight: 22:00-02:00 is the
  // late-night peak every ride-hailing operator runs, and treating it as an
  // empty range would silently switch that surge off.
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}
