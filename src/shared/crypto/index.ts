import { randomBytes } from 'node:crypto';
export function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 15) | 112, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 63) | 128, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
