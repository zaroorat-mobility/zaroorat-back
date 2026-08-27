import { randomBytes } from 'node:crypto';

export function generateUniqueCode(seed?: string | null, prefix = 'REF'): string {
  const slug = (seed ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10);
  const base = slug.length >= 2 ? slug : prefix.toUpperCase().slice(0, 8);
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `${base}${suffix}`.slice(0, 50);
}
