import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuffer = Buffer.from(signature, 'utf-8');
  const expectedBuffer = Buffer.from(expectedHex, 'utf-8');
  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(sigBuffer, expectedBuffer);
}
