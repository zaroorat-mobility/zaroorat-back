export function base64ToHex(value: string | undefined): string | null {
  if (!value) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded.toString('hex') : null;
}
export function hexToBase64(value: string): string {
  return Buffer.from(value, 'hex').toString('base64');
}
