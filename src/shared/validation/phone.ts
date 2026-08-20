export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
export function isValidE164(phoneNumber: string): boolean {
  return E164_PATTERN.test(phoneNumber);
}
export function maskPhone(phoneNumber: string): string {
  const leading = Math.min(8, Math.max(0, phoneNumber.length - 5));
  return `${phoneNumber.slice(0, leading)}•••${phoneNumber.slice(-2)}`;
}
