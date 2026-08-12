export function maskPhone(phoneNumber: string): string {
  const leading = Math.min(8, Math.max(0, phoneNumber.length - 5));
  return `${phoneNumber.slice(0, leading)}•••${phoneNumber.slice(-2)}`;
}
