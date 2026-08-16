// Authentication integration check: real backend, real OTP, no mocks.
//
// The OTP is read from the backend's own dev log, where its mock SMS provider
// writes it ([MockSMS] payload). Nothing here bypasses or fabricates a code.
import assert from 'node:assert';

import { onRequestDiagnostic } from '../src/api/index.ts';
import type { RequestDiagnostic } from '../src/api/index.ts';
import { getMe } from '../src/user/api/user.api.ts';
import {
  authStore,
  clearSession,
  initializeAuth,
  logout,
  refreshSession,
  requestOtp,
  verifyOtp,
} from '../src/auth/auth.store.ts';
import { queryClient } from '../src/lib/queryClient.ts';
import { readOtpFromBackendLog } from './otp.ts';

const REFRESH_PATH = '/api/v1/auth/token/refresh';

const calls: RequestDiagnostic[] = [];
onRequestDiagnostic((entry) => calls.push(entry));

const consoleLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '));
const ok = (label: string) => realDebug(`ok  ${label}`);

const state = () => authStore.getSnapshot();
const countRefreshCalls = () => calls.filter((c) => c.path === REFRESH_PATH).length;

// A fresh number per run: exercises the new-account path, and keeps clear of
// the backend's 3-per-phone-per-hour OTP limit.
const phoneNumber = `+9198${String(Date.now()).slice(-8)}`;

// ---------------------------------------------------------------------------
// 1. Boot restore with a dead refresh token: one attempt, session cleared.
// ---------------------------------------------------------------------------
sessionStorage.setItem('ride-demo.refreshToken', 'not-a-real-refresh-token');
await initializeAuth();
assert.equal(state().status, 'anonymous');
assert.equal(state().hasRefreshToken, false);
assert.equal(sessionStorage.getItem('ride-demo.refreshToken'), null);
assert.equal(countRefreshCalls(), 1, 'refresh failure retried — possible loop');
ok(`dead refresh token -> anonymous after exactly ${countRefreshCalls()} attempt`);

// ---------------------------------------------------------------------------
// 2. Validation error, in the backend's Zod issue format.
// ---------------------------------------------------------------------------
assert.equal(await requestOtp('nope'), false);
assert.equal(state().lastError?.code, 'VALIDATION');
assert.equal(state().lastError?.status, 400);
assert.deepEqual(
  state().lastError?.fieldErrors.map((f) => f.path),
  ['phoneNumber'],
);
ok(`invalid phone -> VALIDATION on field "${state().lastError?.fieldErrors[0]?.path}"`);

// ---------------------------------------------------------------------------
// 3. Send OTP.
// ---------------------------------------------------------------------------
assert.equal(await requestOtp(phoneNumber), true);
const challenge = state().challenge;
assert.ok(challenge, 'no challenge stored');
assert.equal(challenge.phoneNumber, phoneNumber);
assert.ok(challenge.expiresAt > Date.now(), 'challenge already expired');
ok(
  `OTP sent, challenge ${challenge.challengeId.slice(0, 8)}… valid ${Math.round((challenge.expiresAt - Date.now()) / 1000)}s`,
);

// ---------------------------------------------------------------------------
// 4. Wrong code is rejected and does not authenticate.
// ---------------------------------------------------------------------------
assert.equal(await verifyOtp('000000'), null);
assert.equal(state().lastError?.code, 'OTP_INVALID');
assert.equal(state().lastError?.status, 401);
assert.equal(state().status, 'anonymous');
ok('wrong OTP -> OTP_INVALID, still anonymous');

// ---------------------------------------------------------------------------
// 5. Correct code authenticates and registers the new account.
// ---------------------------------------------------------------------------
const code = await readOtpFromBackendLog(phoneNumber);
const session = await verifyOtp(code);
assert.ok(session, `verify failed: ${state().lastError?.code}`);
assert.equal(session.user.isNew, true, 'expected a newly registered account');
assert.equal(state().status, 'authenticated');
assert.equal(state().hasAccessToken, true);
assert.equal(state().hasRefreshToken, true);
assert.ok(state().roles.includes('customer'), `unexpected roles ${state().roles.join()}`);
ok(`verified -> authenticated, isNew=${session.user.isNew}, roles=${state().roles.join()}`);

// The snapshot must never carry the credentials themselves.
const snapshot = JSON.stringify(state());
assert.ok(!snapshot.includes(session.accessToken), 'ACCESS TOKEN in auth state');
assert.ok(!snapshot.includes(session.refreshToken), 'REFRESH TOKEN in auth state');
ok('auth state snapshot holds no token material');

// ---------------------------------------------------------------------------
// 6. A new account's first access token goes stale by design: registration
//    publishes account.role.granted, whose consumer bumps the session epoch
//    ~300ms later (measured), invalidating the token just issued. The 401
//    handler must refresh and replay the request transparently.
// ---------------------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 1200)); // let the bump land
const before = countRefreshCalls();
const me = await getMe();
assert.equal(me.phoneNumber, phoneNumber);
assert.equal(me.status, 'ACTIVE');
const staleRecovery = calls.filter((c) => c.path === '/api/v1/users/me');
assert.equal(staleRecovery.at(0)?.status, 401, 'expected the first /users/me to be rejected');
assert.equal(staleRecovery.at(-1)?.status, 200, 'retry after refresh did not succeed');
assert.equal(countRefreshCalls(), before + 1, 'refresh did not run exactly once');
ok(`stale token -> 401 -> refresh -> retry -> 200 for ${me.phoneNumber}`);

// ---------------------------------------------------------------------------
// 7. Single-flight: concurrent refreshes must collapse into one request.
//    If they did not, the second would replay a consumed token and the backend
//    would revoke the whole session family.
// ---------------------------------------------------------------------------
const concurrentBefore = countRefreshCalls();
const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
assert.deepEqual(results, [true, true, true]);
assert.equal(countRefreshCalls(), concurrentBefore + 1, '3 concurrent refreshes made >1 request');
ok('3 concurrent refreshes -> 1 network call, session intact');

// Session still usable after rotation.
assert.equal((await getMe()).id, me.id);
ok('rotated token still authenticates');

// ---------------------------------------------------------------------------
// 8. Logout revokes server-side, clears locally, and drops cached user state.
// ---------------------------------------------------------------------------
queryClient.setQueryData(['user', 'me'], me);
await logout();
assert.equal(state().status, 'anonymous');
assert.equal(state().hasAccessToken, false);
assert.equal(state().hasRefreshToken, false);
assert.equal(sessionStorage.getItem('ride-demo.refreshToken'), null);
assert.equal(queryClient.getQueryData(['user', 'me']), undefined, 'user left in cache');
const logoutCall = calls.filter((c) => c.path === '/api/v1/auth/logout').at(-1);
assert.equal(logoutCall?.status, 204);
ok('logout -> 204, session and cached user cleared');

// Protected data is genuinely unreachable afterwards.
const afterLogout = await getMe().catch((e: unknown) => e);
assert.ok(afterLogout instanceof Error);
assert.equal((afterLogout as { status?: number }).status, 401);
ok('post-logout /users/me -> 401');

// ---------------------------------------------------------------------------
// 9. Nothing sensitive reached diagnostics or the console.
// ---------------------------------------------------------------------------
clearSession();
const dump = JSON.stringify(calls) + consoleLines.join('\n');
for (const [label, secret] of [
  ['access token', session.accessToken],
  ['refresh token', session.refreshToken],
  ['otp code', code],
] as const) {
  assert.ok(!dump.includes(secret), `${label} LEAKED into logs`);
}
assert.ok(!/authorization|bearer|idempotency-key/i.test(dump), 'header material leaked');
ok(`no tokens or OTP in ${calls.length} diagnostics / ${consoleLines.length} console lines`);

// ---------------------------------------------------------------------------
// 10. The route guard actually withholds protected content. State is anonymous
//     at this point, so /passenger must not render its page.
// ---------------------------------------------------------------------------
const { renderToString } = await import('react-dom/server');
const { createStaticHandler, createStaticRouter, StaticRouterProvider } =
  await import('react-router');
const { AppProviders } = await import('../src/app/providers/AppProviders.tsx');
const { routes } = await import('../src/app/router/index.tsx');

async function renderPath(path: string): Promise<string> {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`${path} redirected`);
  return renderToString(
    AppProviders({
      children: StaticRouterProvider({
        router: createStaticRouter(routes, context),
        context,
      }),
    }) as never,
  );
}

const guarded = await renderPath('/passenger');
assert.ok(!guarded.includes('passenger module'), 'protected page rendered while anonymous');
ok('anonymous /passenger withholds the protected page');

const publicPage = await renderPath('/auth');
assert.ok(publicPage.includes('Authentication'), 'public login page did not render');
ok('anonymous /auth renders the login page');

console.debug = realDebug;
console.log('\nall auth checks passed');
