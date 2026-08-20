// User module integration check: real backend, real account, no mocks.
//
// Registers a throwaway account over the real OTP flow (the code is read from
// the backend's own dev log, where its mock SMS provider writes it), then
// exercises the user query and every render state.
import assert from 'node:assert';

import { renderToString } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';

import { isApiError, onRequestDiagnostic } from '../src/api/index.ts';
import type { RequestDiagnostic } from '../src/api/index.ts';
import { authStore, logout, requestOtp, verifyOtp } from '../src/auth/auth.store.ts';
import { queryClient } from '../src/lib/queryClient.ts';
import { createUpload } from '../src/files/api/files.api.ts';
import { validateProfileImage } from '../src/files/upload.ts';
import { getMe, updateProfile, userQueryKey } from '../src/user/api/user.api.ts';
import { Avatar } from '../src/user/components/Avatar.tsx';
import { DefaultAvatar } from '../src/user/components/DefaultAvatar.tsx';
import type { User } from '../src/user/api/user.types.ts';
import { UserProfilePage } from '../src/user/pages/UserProfilePage.tsx';
import { readOtpFromBackendLog } from './otp.ts';

const calls: RequestDiagnostic[] = [];
onRequestDiagnostic((entry) => calls.push(entry));

const consoleLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '));
const ok = (label: string) => realDebug(`ok  ${label}`);

const meCalls = () => calls.filter((c) => c.path === '/api/v1/users/me');
const refreshCalls = () => calls.filter((c) => c.path === '/api/v1/auth/token/refresh');

/** Renders a subtree with its own cache so each state can be asserted alone. */
function render(node: React.ReactNode, client: QueryClient = queryClient): string {
  return renderToString(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

// ---------------------------------------------------------------------------
// 1. Anonymous: the profile page renders without ever calling /users/me.
// ---------------------------------------------------------------------------
assert.equal(authStore.getSnapshot().status, 'initializing');
const anonymousHtml = render(<UserProfilePage />, new QueryClient());
assert.equal(meCalls().length, 0, 'anonymous render requested /users/me');
assert.ok(!anonymousHtml.includes('Loading profile'), 'anonymous render showed a loading state');
ok('anonymous -> no /users/me request');

// ---------------------------------------------------------------------------
// 2. Real login on a throwaway number.
// ---------------------------------------------------------------------------
const phoneNumber = `+9198${String(Date.now()).slice(-8)}`;
assert.equal(await requestOtp(phoneNumber), true, authStore.getSnapshot().lastError?.code);

const code = await readOtpFromBackendLog(phoneNumber);

const session = await verifyOtp(code);
assert.ok(session, `verify failed: ${authStore.getSnapshot().lastError?.code}`);
assert.equal(session.user.isNew, true, 'expected a brand-new account');
ok(`registered ${phoneNumber} (isNew=${session.user.isNew})`);

// ---------------------------------------------------------------------------
// 3. The response matches the transcribed contract exactly.
// ---------------------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 1200)); // let the epoch bump land
const refreshesBefore = refreshCalls().length;
const user: User = await getMe();

assert.deepEqual(Object.keys(user).sort(), [
  'createdAt',
  'email',
  'id',
  'isEmailVerified',
  'isPhoneVerified',
  'lastLoginAt',
  'phoneNumber',
  'profile',
  'roles',
  'status',
]);
assert.equal(user.phoneNumber, phoneNumber);
assert.equal(user.status, 'ACTIVE');
assert.equal(user.isPhoneVerified, true);
assert.equal(user.isEmailVerified, false);
assert.equal(user.email, null);
assert.ok(Array.isArray(user.roles) && user.roles.includes('customer'));
assert.match(user.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'createdAt is not ISO 8601 UTC');
ok(`GET /users/me -> ${user.status}, roles=${user.roles.join()}, 10 fields as typed`);

// profile is an object, never null, with all seven keys present.
assert.ok(user.profile !== null && typeof user.profile === 'object', 'profile was null');
assert.deepEqual(Object.keys(user.profile).sort(), [
  'dateOfBirth',
  'firstName',
  'gender',
  'languageCode',
  'lastName',
  'profileImageFileId',
  'referralCode',
]);
assert.equal(user.profile.firstName, null);
assert.equal(user.profile.languageCode, 'en', 'expected the backend default language');
ok('profile object present with all 7 keys, empty but for the default language');

// ---------------------------------------------------------------------------
// 4. The stale-token recovery stayed inside the API/auth layer.
// ---------------------------------------------------------------------------
assert.equal(meCalls().at(0)?.status, 401, 'expected the new account token to be stale');
assert.equal(meCalls().at(-1)?.status, 200, 'retry after refresh did not succeed');
assert.equal(refreshCalls().length, refreshesBefore + 1, 'user module refreshed more than once');
ok('401 -> refresh -> retry handled beneath the user module (1 refresh)');

// ---------------------------------------------------------------------------
// 5. Render states, driven by the real response.
// ---------------------------------------------------------------------------
const loadingHtml = render(<UserProfilePage />, new QueryClient());
assert.ok(loadingHtml.includes('Loading profile'), 'no loading state while pending');
assert.ok(!loadingHtml.includes(phoneNumber), 'rendered data while still loading');
ok('authenticated + pending -> "Loading profile…"');

queryClient.setQueryData(userQueryKey, user);
const loadedHtml = render(<UserProfilePage />);
assert.ok(loadedHtml.includes(phoneNumber), 'phone number missing');
assert.ok(loadedHtml.includes(user.id), 'user id missing');
assert.ok(loadedHtml.includes('ACTIVE'), 'account status missing');
assert.ok(loadedHtml.includes('customer'), 'role chip missing');
assert.ok(loadedHtml.includes('✓ Verified'), 'verified phone not shown');
assert.ok(loadedHtml.includes('Not verified'), 'unverified email not shown');
assert.ok(loadedHtml.includes('No email on file'), 'null email not given an empty state');
assert.ok(!/>\s*(null|undefined|N\/A)\s*</.test(loadedHtml), 'raw null/undefined rendered');

// Every field is labelled, including the ones that are empty on a new account.
for (const label of [
  'User ID',
  'Phone',
  'Email',
  'Account status',
  'Verification',
  'Roles',
  'Created',
  'Last login',
  'Full name',
  'First name',
  'Last name',
  'Date of birth',
  'Gender',
  'Language',
  'Referral code',
  'Profile image file ID',
]) {
  assert.ok(loadedHtml.includes(label), `field "${label}" is not rendered`);
}
ok('loaded -> all 16 account + profile fields rendered, empty ones labelled');

// ---------------------------------------------------------------------------
// 5b. PATCH /users/me/profile — real partial update.
// ---------------------------------------------------------------------------
const updated = await updateProfile({
  firstName: 'Asha',
  lastName: "D'Souza-Rao",
  dateOfBirth: '1998-04-12',
  gender: 'FEMALE',
  languageCode: 'hi',
});
assert.equal(updated.firstName, 'Asha');
assert.equal(updated.lastName, "D'Souza-Rao");
assert.equal(updated.dateOfBirth, '1998-04-12', 'date came back in a different shape');
assert.equal(updated.gender, 'FEMALE');
assert.equal(updated.languageCode, 'hi');
assert.deepEqual(Object.keys(updated).sort(), Object.keys(user.profile).sort());
ok(
  `PATCH profile -> ${updated.firstName} ${updated.lastName}, ${updated.gender}, ${updated.languageCode}`,
);

// The change is real: a fresh read returns it.
const reread = await getMe();
assert.equal(reread.profile.firstName, 'Asha');
assert.equal(reread.profile.dateOfBirth, '1998-04-12');
ok('re-read confirms the update persisted');

// Partial: an unsent field is left alone, and null clears one.
const cleared = await updateProfile({ lastName: null });
assert.equal(cleared.lastName, null, 'null did not clear the field');
assert.equal(cleared.firstName, 'Asha', 'an unsent field was overwritten');
ok('partial update -> null cleared lastName, firstName untouched');

// Populated profile renders its values.
queryClient.setQueryData(userQueryKey, reread);
const filledHtml = render(<UserProfilePage />);
assert.ok(filledHtml.includes('Asha'), 'updated name not rendered');
assert.ok(filledHtml.includes('FEMALE'), 'gender not rendered');
ok('populated profile renders the saved values');

// ---------------------------------------------------------------------------
// 5c. Validation errors come back as { field, code } — the third format.
// ---------------------------------------------------------------------------
const tooYoung = await updateProfile({ dateOfBirth: '2020-01-01' }).catch((e: unknown) => e);
assert.ok(isApiError(tooYoung), 'expected an ApiError');
assert.equal(tooYoung.status, 400);
assert.equal(tooYoung.code, 'VALIDATION');
assert.deepEqual(tooYoung.validationErrors, [
  { path: 'dateOfBirth', code: 'AGE_BELOW_MINIMUM', message: 'AGE_BELOW_MINIMUM' },
]);
ok(`under-age DOB -> ${tooYoung.validationErrors[0]?.path}: ${tooYoung.validationErrors[0]?.code}`);

// Same endpoint, different validator: Fastify's JSON schema declares the enums
// and rejects them before the request reaches Zod, so this one arrives in the
// `instancePath` format instead. Both must normalize.
const badLanguage = await updateProfile({ languageCode: 'zz' }).catch((e: unknown) => e);
assert.ok(isApiError(badLanguage) && badLanguage.code === 'VALIDATION');
assert.equal(badLanguage.validationErrors[0]?.path, 'languageCode');
assert.equal(badLanguage.validationErrors[0]?.code, undefined, 'expected the Fastify shape');
assert.match(badLanguage.validationErrors[0]?.message ?? '', /allowed values/);
ok('unsupported language -> Fastify-format issue on languageCode, normalized');

const blankName = await updateProfile({ firstName: '' }).catch((e: unknown) => e);
assert.ok(isApiError(blankName) && blankName.code === 'VALIDATION');
assert.deepEqual(
  blankName.validationErrors.map((i) => `${i.path}:${i.code}`),
  ['firstName:REQUIRED', 'firstName:INVALID_FORMAT'],
);
ok('blank name -> users-format { field, code } issues, normalized');

// Identity fields are refused before validation even runs.
const immutable = await updateProfile({ phoneNumber: '+910000000000' } as never).catch(
  (e: unknown) => e,
);
assert.ok(isApiError(immutable), 'expected an ApiError');
assert.equal(immutable.code, 'IMMUTABLE_FIELD');
assert.equal(immutable.validationErrors[0]?.code, 'IMMUTABLE');
ok(`immutable field -> ${immutable.code} on ${immutable.validationErrors[0]?.path}`);

// ---------------------------------------------------------------------------
// 5d. Default avatars: gendered silhouettes, no image request, no upload needed.
// ---------------------------------------------------------------------------
const filesCalls = () => calls.filter((c) => c.path.startsWith('/api/v1/files'));
const filesBefore = filesCalls().length;

const male = render(<DefaultAvatar gender="MALE" seed={user.id} />, new QueryClient());
const female = render(<DefaultAvatar gender="FEMALE" seed={user.id} />, new QueryClient());
const neutral = render(<DefaultAvatar gender={null} seed={user.id} />, new QueryClient());

assert.ok(male.includes('Default avatar, masculine'), 'male avatar unlabelled');
assert.ok(female.includes('Default avatar, feminine'), 'female avatar unlabelled');
assert.ok(neutral.includes('aria-label="Default avatar"'), 'neutral avatar unlabelled');
assert.notEqual(male, female, 'male and female avatars are identical');
assert.notEqual(neutral, male, 'neutral and male avatars are identical');
for (const [label, svg] of [
  ['male', male],
  ['female', female],
  ['neutral', neutral],
] as const) {
  assert.ok(svg.includes('<svg'), `${label} avatar is not inline svg`);
  assert.ok(!svg.includes('http'), `${label} avatar reaches for an external resource`);
}
ok('default avatars: 3 distinct inline SVGs, no external requests');

// Distinct users get distinct colours from the same silhouette.
const otherSeed = render(<DefaultAvatar gender="MALE" seed="00000000-1111" />, new QueryClient());
assert.notEqual(otherSeed, male, 'avatar palette is not seeded by user');
ok('avatar palette varies by user id');

// No photo on file -> the default renders and no presigned URL is requested.
const avatarHtml = render(
  <Avatar fileId={null} gender="FEMALE" seed={user.id} />,
  new QueryClient(),
);
assert.ok(avatarHtml.includes('Default avatar, feminine'));
assert.equal(filesCalls().length, filesBefore, 'a files request was made with no photo attached');
ok('Avatar with no photo -> default, zero /files requests');

// ---------------------------------------------------------------------------
// 5e. Upload guards, and the real first step of the upload.
// ---------------------------------------------------------------------------
const notAnImage = new File(['plain text'], 'notes.txt', { type: 'text/plain' });
assert.match((await validateProfileImage(notAnImage)) ?? '', /Accepted: JPEG, PNG or WebP/);

const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
assert.match((await validateProfileImage(oversized)) ?? '', /The limit is 5 MB/);
assert.equal(filesCalls().length, filesBefore, 'a rejected file still hit the backend');
ok('client guards reject wrong type and >5MB before any request');

// Real POST /api/v1/files — a genuine presigned PUT comes back.
const reservation = await createUpload(
  {
    purpose: 'PROFILE_IMAGE',
    fileName: 'avatar.png',
    contentType: 'image/png',
    sizeBytes: 2048,
  },
  crypto.randomUUID(),
);
assert.match(reservation.fileId, /^[0-9a-f-]{36}$/);
assert.equal(reservation.status, 'PENDING');
assert.equal(reservation.upload.method, 'PUT');
assert.ok(reservation.upload.url.startsWith('http'), 'no presigned URL returned');
assert.equal(reservation.upload.headers['Content-Type'], 'image/png');
assert.ok(new Date(reservation.upload.expiresAt).getTime() > Date.now(), 'upload already expired');
ok(`POST /files -> ${reservation.status}, presigned PUT expiring ${reservation.upload.expiresAt}`);

// The type policy is enforced server-side too, not only in the browser.
const refused = await createUpload(
  { purpose: 'PROFILE_IMAGE', fileName: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 10 },
  crypto.randomUUID(),
).catch((e: unknown) => e);
assert.ok(isApiError(refused), 'expected an ApiError');
assert.equal(refused.code, 'UNSUPPORTED_MEDIA_TYPE');
ok(`backend refuses a PDF for PROFILE_IMAGE -> ${refused.status} ${refused.code}`);

// ---------------------------------------------------------------------------
// 6. Error state, rendered from a real backend rejection.
// ---------------------------------------------------------------------------
await logout();
const realFailure = await getMe().catch((e: unknown) => e);
assert.ok(isApiError(realFailure) && realFailure.status === 401);

const errorClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
await errorClient
  .fetchQuery({ queryKey: userQueryKey, queryFn: () => Promise.reject(realFailure) })
  .catch(() => {});
const errorHtml = render(<UserProfilePage />, errorClient);
assert.ok(errorHtml.includes('Unable to load your profile'), 'no error message');
assert.ok(errorHtml.includes(realFailure.code), 'backend error code not surfaced');
ok(`error -> "Unable to load your profile." with ${realFailure.status} ${realFailure.code}`);

// ---------------------------------------------------------------------------
// 7. Logout dropped the cached user, and the page stops showing it.
// ---------------------------------------------------------------------------
assert.equal(queryClient.getQueryData(userQueryKey), undefined, 'user survived logout');
assert.equal(authStore.getSnapshot().status, 'anonymous');
const afterLogoutHtml = render(<UserProfilePage />);
assert.ok(!afterLogoutHtml.includes(phoneNumber), 'profile still visible after logout');
ok('logout -> cached user removed, page no longer renders it');

// ---------------------------------------------------------------------------
// 8. Nothing sensitive in the output.
// ---------------------------------------------------------------------------
const dump = JSON.stringify(calls) + consoleLines.join('\n') + loadedHtml;
for (const [label, secret] of [
  ['access token', session.accessToken],
  ['refresh token', session.refreshToken],
  ['otp code', code],
] as const) {
  assert.ok(!dump.includes(secret), `${label} LEAKED into output`);
}
assert.ok(!/authorization|bearer/i.test(dump), 'header material leaked');
ok(
  `no tokens or OTP across ${calls.length} calls, ${consoleLines.length} logs and the rendered page`,
);

console.debug = realDebug;
console.log('\nall user module checks passed');
