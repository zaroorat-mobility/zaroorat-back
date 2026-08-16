import { randomUUID } from 'node:crypto';
export function generateDriverCode(): string {
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = randomUUID().substring(0, 4).toUpperCase();
  return `DRV_${timestampPart}_${randomPart}`;
}
