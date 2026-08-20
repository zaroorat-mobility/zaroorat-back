/** Backend timestamps are ISO 8601 UTC; shown in the viewer's local zone. */
export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * `dateOfBirth` is a calendar date (`YYYY-MM-DD`), not a timestamp. Parsing it
 * with `new Date()` would read it as UTC midnight and shift it a day backwards
 * for anyone west of Greenwich, so it is formatted from its parts instead.
 */
export function formatDateOnly(value: string | null): string | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString();
}

/** Keeps the country code and last two digits: +919876543210 → +91*******10 */
export function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length <= 5) return phoneNumber;
  const head = phoneNumber.slice(0, 3);
  const tail = phoneNumber.slice(-2);
  return `${head}${'*'.repeat(phoneNumber.length - 5)}${tail}`;
}
