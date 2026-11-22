import { randomBytes } from 'node:crypto';

export function generateReferralCode(seed?: string | null, prefix = 'REF'): string {
  const slug = (seed ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8);
  const base = slug.length >= 2 ? slug : prefix.toUpperCase().slice(0, 6);
  const suffix = randomBytes(2).toString('hex').toUpperCase();
  return `${base}${suffix}`.slice(0, 12);
}
