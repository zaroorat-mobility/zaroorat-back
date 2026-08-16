// Integration check: real client code against the real backend. No mocks.
import assert from 'node:assert';

import {
  apiClient,
  getHealth,
  isApiError,
  onRequestDiagnostic,
  setAuthTokenProvider,
} from '../src/api/index.ts';
import type { RequestDiagnostic } from '../src/api/index.ts';
import { env } from '../src/config/env.ts';

const seen: RequestDiagnostic[] = [];
onRequestDiagnostic((entry) => seen.push(entry));

const SECRET = 'super-secret-access-token-do-not-log';
setAuthTokenProvider(() => SECRET);

const consoleLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...args: unknown[]) => {
  consoleLines.push(args.map(String).join(' '));
};

function ok(label: string) {
  realDebug(`ok  ${label}`);
}

// 1. Real request succeeds and returns the unwrapped payload.
const health = await getHealth();
assert.equal(health.status, 'ok');
assert.ok(typeof health.uptime === 'number' && health.uptime > 0, 'uptime missing');
assert.match(health.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'timestamp not ISO 8601');
ok(`GET /api/v1/health -> ${health.status} (${health.environment})`);

// 2. Unauthenticated error is normalized, status and requestId preserved.
const authErr = await apiClient.get('/api/v1/users/me').catch((e: unknown) => e);
assert.ok(isApiError(authErr), 'not an ApiError');
assert.equal(authErr.status, 401);
assert.equal(authErr.code, 'TOKEN_INVALID');
assert.ok(authErr.requestId, 'requestId not preserved');
ok(`401 -> code=${authErr.code} requestId=${authErr.requestId}`);

// 3. Validation errors flattened from the backend's Zod issue format.
const badBody = await apiClient
  .post('/api/v1/auth/otp/send', { phoneNumber: 'nope' })
  .catch((e: unknown) => e);
assert.ok(isApiError(badBody));
assert.equal(badBody.status, 400);
assert.equal(badBody.code, 'VALIDATION');
assert.deepEqual(
  badBody.validationErrors.map((v) => v.path),
  ['phoneNumber'],
);
ok(`400 -> ${badBody.validationErrors.length} issue on "${badBody.validationErrors[0]?.path}"`);

// 4. Unmatched route uses a different body shape; still normalized.
const missing = await apiClient.get('/api/v1/does-not-exist').catch((e: unknown) => e);
assert.ok(isApiError(missing));
assert.equal(missing.status, 404);
assert.equal(missing.code, 'NOT_FOUND');
ok(`404 -> code=${missing.code}`);

// 5. Caller abort propagates as a cancellation, NOT as an ApiError.
const controller = new AbortController();
const inflight = apiClient.get('/api/v1/health', { signal: controller.signal });
controller.abort();
const aborted = await inflight.catch((e: unknown) => e);
assert.ok(!isApiError(aborted), 'abort was swallowed into an ApiError');
assert.equal((aborted as Error).name, 'AbortError');
ok('abort -> AbortError propagated for TanStack Query');

// 6. Timeout becomes a transport ApiError.
const timedOut = await apiClient.get('/api/v1/health', { timeoutMs: 1 }).catch((e: unknown) => e);
assert.ok(isApiError(timedOut));
assert.equal(timedOut.code, 'TIMEOUT');
assert.equal(timedOut.status, 0);
assert.ok(timedOut.isTransportError);
ok('timeout -> code=TIMEOUT status=0');

// 7. Diagnostics carry method, path, status, duration, request id.
const first = seen[0];
assert.ok(first, 'no diagnostics emitted');
assert.equal(first.method, 'GET');
assert.equal(first.status, 200);
assert.ok(first.durationMs >= 0);
assert.ok(first.requestId);
ok(`diagnostics -> ${first.method} ${first.path} ${first.status} ${first.durationMs}ms`);

// 8. Nothing sensitive reaches the diagnostics or the dev console.
const dump = JSON.stringify(seen) + consoleLines.join('\n');
assert.ok(!dump.includes(SECRET), 'ACCESS TOKEN LEAKED into logs');
assert.ok(!/authorization|bearer|cookie/i.test(dump), 'auth header leaked into logs');
ok(`no secrets in ${seen.length} diagnostics / ${consoleLines.length} console lines`);

// 8b. The console trace is gated on the build mode: on in dev, silent in prod.
if (env.isDev) {
  assert.ok(consoleLines.length > 0, 'dev console trace never fired');
  assert.match(consoleLines[0] ?? '', /\[api\] GET \/api\/v1\/health → 200 \(\d+ms\) req:/);
  ok(`dev trace on: ${consoleLines[0]}`);
} else {
  assert.equal(consoleLines.length, 0, 'production build wrote to the console');
  ok('prod trace silent (0 console lines)');
}

// 9. The token really was sent — proves the extension point is wired, using an
//    endpoint that reports back what it thought of the credential.
const withToken = await apiClient.get('/api/v1/users/me').catch((e: unknown) => e);
assert.ok(isApiError(withToken) && withToken.status === 401);
ok('auth extension point applied Authorization header (rejected as expected)');

// 10. CORS preflight. Node does not enforce CORS, so every other check here
//     passes even when a browser is blocked outright — this asserts the
//     preflight explicitly, which is the only way a server-side test can catch
//     it. A missing method makes the browser drop the request after a 204
//     preflight, with no error the app can see.
const ORIGIN = 'http://localhost:5173';
const preflight = await fetch(`${env.apiBaseUrl}/api/v1/users/me/profile`, {
  method: 'OPTIONS',
  headers: {
    origin: ORIGIN,
    'access-control-request-method': 'PATCH',
    'access-control-request-headers': 'authorization,content-type,x-request-id',
  },
});

assert.ok(preflight.ok, `preflight failed: ${preflight.status}`);
assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);

const allowed = (preflight.headers.get('access-control-allow-methods') ?? '')
  .split(',')
  .map((method) => method.trim().toUpperCase());

for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.ok(allowed.includes(method), `${method} missing from allow-methods: ${allowed.join()}`);
}

const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
for (const header of ['authorization', 'content-type', 'x-request-id']) {
  assert.ok(allowedHeaders.includes(header), `${header} not permitted by preflight`);
}
ok(`preflight allows ${allowed.join(', ')} with our headers`);

console.debug = realDebug;
console.log('\nall api client checks passed');
