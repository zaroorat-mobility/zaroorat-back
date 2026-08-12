import { Decimal } from '../types/index.js';

export function toMinorUnits(amount: number | string | Decimal): number {
  const dec = new Decimal(amount);
  return Math.round(dec.mul(100).toNumber());
}

export function toMajorDecimal(minorUnits: number): Decimal {
  return new Decimal(minorUnits).div(100);
}

export function formatCurrency(minorUnits: number, currency = 'INR'): string {
  const major = (minorUnits / 100).toFixed(2);
  return `${currency} ${major}`;
}
