/// Provider, queue and integration errors routinely echo what they were sent — a phone
/// number, an email address, an OTP, a token. Two tools, for two places:
///
/// - `safeErrorSummary` for audit rows: a stable code and a reason from a fixed
///   vocabulary. The message itself is never stored.
/// - `redactSensitive` for operator views that need the text (the job browser's
///   `failedReason`): every value-shaped run is replaced, not trimmed.
///
/// The full error belongs in the server log only.

type Replacer = string | ((match: string) => string);

const REDACTIONS: ReadonlyArray<readonly [RegExp, Replacer]> = [
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[^\s,;]+/gi, '$1 [redacted]'],
  // JWTs (three base64url segments).
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[token]'],
  // key=value / key: value pairs whose key names a secret.
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|otp|pin|code|authorization|signature|key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1$2[redacted]',
  ],
  // Email addresses.
  [/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]'],
  // URLs (query strings carry keys and recipients).
  [/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]'],
  // Any run of four or more digits, with the separators phone numbers use: OTPs, PINs,
  // phone, card and account numbers.
  [/\+?\d(?:[\d\s().-]{2,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 4 ? '[number]' : m)],
  // Long opaque strings: API keys and secrets without a recognisable prefix.
  [/\b[\w-]{24,}\b/g, '[redacted]'],
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out =
      typeof replacement === 'function'
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  }
  return out;
}

export interface SafeErrorSummary {
  /// Stable and machine-readable: the error's own code when it is one, else derived from
  /// its HTTP status or name.
  errorCode: string;
  /// The error's class name (`OtpDeliveryRetryableError`), when it has an identifier shape.
  errorName?: string;
  /// Short and human-readable, chosen from a fixed vocabulary by `errorCode`.
  reason: string;
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/// Never the message: an allowlist of what can be said, so no provider text — redacted or
/// not — reaches an audit row. A name or address is PII no pattern catches.
function describe(errorCode: string): string {
  if (errorCode === 'TIMEOUT') return 'Timed out';
  if (errorCode === 'EXTERNAL_ERROR') return 'External action failed';
  const http = /^HTTP_(\d{3})$/.exec(errorCode);
  if (http) {
    return Number(http[1]) >= 500
      ? `Upstream error (HTTP ${http[1]})`
      : `Request refused (HTTP ${http[1]})`;
  }
  return `Failed: ${errorCode}`;
}

export function safeErrorSummary(err: unknown): SafeErrorSummary {
  const e = (err ?? {}) as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    name?: unknown;
  };
  const status =
    typeof e.statusCode === 'number'
      ? e.statusCode
      : typeof e.status === 'number'
        ? e.status
        : undefined;
  const errorCode =
    typeof e.code === 'string' && CODE_SHAPE.test(e.code)
      ? e.code
      : status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
        ? `HTTP_${status}`
        : typeof e.name === 'string' && /timeout/i.test(e.name)
          ? 'TIMEOUT'
          : 'EXTERNAL_ERROR';
  const errorName = typeof e.name === 'string' && NAME_SHAPE.test(e.name) ? e.name : undefined;
  return { errorCode, ...(errorName ? { errorName } : {}), reason: describe(errorCode) };
}
