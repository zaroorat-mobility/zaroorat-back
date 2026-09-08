const SENSITIVE_FIELDS = [
  'password',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'authorization',
  'authkey',
  'authKey',
  'secret',
  'phone',
  'phoneNumber',
  'mobiles',
  'to',
  'otp',
  'otpCode',
  // The ride-start credential, in every spelling it travels under. `plaintextOtp`
  // is here even though the field is gone from the accept path: it was absent
  // from this list for the whole time it *was* being returned to drivers, so the
  // one thing standing between a stray `logger.info({ result })` and a code in
  // the logs was that nobody happened to write one.
  'plaintextOtp',
  'pin',
  'newPin',
  'currentPin',
  'pinCode',
  'ridePin',
  // MockProvider logs this at debug in development, and `logger.ts` disables the
  // otp/phone redaction paths there — so a development log could carry the full
  // SMS body. A Ride PIN is a standing credential even on a developer's laptop.
  'devSmsBody',
  'verificationCode',
  'body',
  'variables',
];
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((field) => `*.${field}`),
];
