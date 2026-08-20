import { readFileSync } from 'node:fs';

/**
 * Reads the OTP the backend just sent, from its own dev log — the mock SMS
 * provider writes the message body at debug level in development. Nothing here
 * bypasses or fabricates a code.
 *
 * Polls, because pino's write can land a moment after the HTTP response.
 */
export async function readOtpFromBackendLog(
  phoneNumber: string,
  timeoutMs = 5_000,
): Promise<string> {
  const logPath = process.env.BACKEND_LOG ?? `${process.env.TEMP}/be.log`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const blocks = readFileSync(logPath, 'utf8').split('[MockSMS] payload').slice(1).reverse();
    for (const block of blocks) {
      if (!block.includes(phoneNumber)) continue;
      const code = /(\d{6}) is your verification code/.exec(block)?.[1];
      if (code) return code;
    }
    if (Date.now() > deadline) {
      throw new Error(`no OTP logged for ${phoneNumber} in ${logPath} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
