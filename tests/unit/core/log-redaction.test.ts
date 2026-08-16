import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import pino from 'pino';

import { REDACT_PATHS } from '../../../src/shared/logger/redact.js';

/** A logger wired exactly like the real one, but writing somewhere we can read. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });

  return { logger: pino({ level: 'debug', redact: REDACT_PATHS }, stream), lines };
}

const SECRETS = {
  phoneNumber: '+919876543210',
  phone: '+919876543211',
  to: '+919876543212',
  mobiles: '919876543213',
  otp: '123456',
  accessToken: 'eyJhbGciOi.header.signature',
  refreshToken: 'refresh-abcdef',
  token: 'bearer-abcdef',
  authorization: 'Bearer abcdef',
  authKey: 'msg91-secret-key',
  password: 'hunter2',
  body: 'Zaroorat: 123456 is your verification code.',
};

describe('log redaction (REDACT_PATHS)', () => {
  it('redacts every sensitive field at the top level', () => {
    const { logger, lines } = captureLogger();
    logger.info(SECRETS, 'test');

    const line = lines[0] as Record<string, unknown>;
    for (const key of Object.keys(SECRETS)) {
      assert.equal(line[key], '[Redacted]', `${key} was logged in the clear`);
    }
  });

  it('redacts the same fields one level down', () => {
    const { logger, lines } = captureLogger();
    logger.info({ delivery: SECRETS }, 'test');

    const nested = (lines[0] as { delivery: Record<string, unknown> }).delivery;
    for (const key of Object.keys(SECRETS)) {
      assert.equal(nested[key], '[Redacted]', `delivery.${key} was logged in the clear`);
    }
  });

  it('redacts the authorization and cookie request headers', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { authorization: 'Bearer x', cookie: 'sid=y' } } }, 'test');

    const headers = (lines[0] as { req: { headers: Record<string, unknown> } }).req.headers;
    assert.equal(headers.authorization, '[Redacted]');
    assert.equal(headers.cookie, '[Redacted]');
  });

  it('no OTP, phone number or token survives anywhere in the serialised line', () => {
    const { logger, lines } = captureLogger();
    logger.info({ ...SECRETS, delivery: SECRETS }, 'test');

    const serialised = JSON.stringify(lines[0]);
    for (const value of Object.values(SECRETS)) {
      assert.ok(!serialised.includes(value), `"${value}" reached the log`);
    }
  });

  it('keeps the operational fields that make a log line useful', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        code: 'RATE_LIMITED',
        challengeId: '0199a0b1-0000-7000-8000-000000000001',
        provider: 'msg91',
        requestId: 'req-7',
        recipient: '+9198765•••10',
        status: 503,
      },
      'test',
    );

    const line = lines[0] as Record<string, unknown>;
    assert.equal(line.code, 'RATE_LIMITED', 'domain error codes must stay readable');
    assert.equal(line.challengeId, '0199a0b1-0000-7000-8000-000000000001');
    assert.equal(line.provider, 'msg91');
    assert.equal(line.requestId, 'req-7');
    assert.equal(line.status, 503);
    assert.equal(line.recipient, '+9198765•••10', 'an already-masked number stays legible');
  });
});
