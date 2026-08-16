# ride-demo-frontend

Developer console for exercising the ride-platform backend. Not the customer app.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the two URLs
npm run dev
```

| Script               | Does                                                |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Vite dev server                                     |
| `npm run build`      | Typecheck, then bundle                              |
| `npm run preview`    | Serve the production bundle                         |
| `npm run check:api`  | Runs the API client against the running backend     |
| `npm run check:auth` | Runs the full auth flow against the running backend |
| `npm run check:user` | Runs the user module against the running backend    |

These are integration tests, not unit tests — they need the backend up and they
make real requests.

To run them against a backend on another port, **override the variable, never
edit `.env`** — Vite gives `process.env` precedence, and editing `.env` while a
dev server is running makes it reload with the wrong API URL:

```bash
VITE_API_BASE_URL=http://localhost:8001 BACKEND_LOG=$TEMP/be2.log npm run check:user
```

`check:auth` and `check:user` each register a real account
on a throwaway
phone number and reads the OTP from the backend's dev log (see below), so it
consumes OTP rate-limit budget: the backend allows 10 verifies per IP per 15
minutes. Clear the counters between rapid runs with
`docker exec zaroorat-redis sh -c "redis-cli --scan --pattern 'ratelimit:*' | xargs -r redis-cli DEL"`.

## Environment

Both variables are required; the app throws on startup if either is missing.

| Variable            | Example                 |
| ------------------- | ----------------------- |
| `VITE_API_BASE_URL` | `http://localhost:3000` |
| `VITE_SOCKET_URL`   | `ws://localhost:3000`   |

`VITE_*` values are compiled into the client bundle. Never put a secret in one.

## Backend contract

Verified against the backend source and against a running instance, not against
the OpenAPI document. `VITE_API_BASE_URL` is the **origin** — paths carry their
own `/api/v1` prefix, because `/health`, `/ready` and `/docs` also sit at root.

| Aspect          | Reality                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Framework       | Fastify 5 (`src/app/app.ts`)                                                                                                   |
| API prefix      | `/api/v1` (`src/routes/register.ts`)                                                                                           |
| Success body    | **No single envelope.** auth/users/files return the payload bare; rides/drivers/payments wrap it in `{ data }`                 |
| Error body      | `{ error: { code, messageKey, message, requestId, retryAfterSec?, details? } }`                                                |
| Unmatched route | `{ success: false, message }` — the one exception, no code and no requestId                                                    |
| Validation      | `error.details` is either Fastify schema issues (`instancePath`) or Zod issues (`path[]`)                                      |
| Auth            | `Authorization: Bearer <jwt>`, deny-by-default; refresh token travels in the body, not a cookie                                |
| Request ID      | Request header `x-request-id`; Fastify adopts an incoming value. Returned only inside error bodies, never as a response header |
| Idempotency     | `Idempotency-Key` header, required by state-changing auth/files/payments routes                                                |
| Dates           | ISO 8601 UTC strings                                                                                                           |
| Pagination      | Not present                                                                                                                    |

`src/api/` owns all of this. Modules call `apiClient` and declare which of the
two success shapes they get; the client never guesses.

## Authentication

The backend has **no password login and no registration endpoint**. Identity is
proved by OTP, and `POST /api/v1/auth/otp/verify` both signs in and creates the
account — it reports which happened via `user.isNew`. The frontend therefore has
no `LoginForm` with a password, no `RegisterForm` and no `RegisterPage`; those
files would describe flows that do not exist.

| Operation    | Method | Endpoint                     | Auth | Idempotency-Key |
| ------------ | ------ | ---------------------------- | ---- | --------------- |
| Send OTP     | POST   | `/api/v1/auth/otp/send`      | no   | no              |
| Verify OTP   | POST   | `/api/v1/auth/otp/verify`    | no   | **required**    |
| Refresh      | POST   | `/api/v1/auth/token/refresh` | no   | **required**    |
| Logout       | POST   | `/api/v1/auth/logout`        | yes  | no              |
| Current user | GET    | `/api/v1/users/me`           | yes  | no              |

Access tokens live 15 minutes, refresh tokens 30 days. Refresh **rotates**: the
old token is consumed, and replaying it revokes the entire session family with
`401 TOKEN_REUSE`. That is why refresh is single-flight — concurrent 401s share
one in-flight request rather than racing to spend the same token.

### A backend behaviour worth knowing

Registration publishes `account.role.granted`, whose consumer bumps the user's
session epoch about 300ms later. The access token minted moments earlier carries
the old epoch, so **a brand-new account's first access token goes stale within a
second of being issued**. The client recovers on its own — 401 `TOKEN_STALE`
triggers one refresh and one replay — but any client of this backend that lacks
refresh-on-401 will appear to log in and then immediately fail. Unchanged here;
flagged for the backend team.

### Token storage

| Token   | Where                | Survives reload | Survives tab close |
| ------- | -------------------- | --------------- | ------------------ |
| Access  | module variable only | no              | no                 |
| Refresh | `sessionStorage`     | yes             | no                 |

Neither token is in the auth store's published snapshot, so nothing that renders
or logs auth state can reach one. The debug panel shows only `present`/`missing`.

**Tradeoff, stated plainly:** `sessionStorage` is readable by any script running
on this origin, so an XSS bug would expose the refresh token. This is acceptable
for a local developer console and is _not_ production-grade. A production client
would keep the refresh token in an `HttpOnly; Secure; SameSite` cookie — which
this backend does not currently issue, since it takes the refresh token in the
request body. `sessionStorage` was chosen over `localStorage` deliberately: it
is not shared across tabs and dies with the tab.

## User

`GET /api/v1/users/me` is owned by `src/user/`, which is the only place that
requests user-domain data. Auth owns the session; the user module owns the
person. Nothing copies the user object into the auth store.

`profile` is **never null**: `toProfileView` maps a missing profile row to an
all-null object, so the key is always present with all seven fields, and
`languageCode` is defaulted to `'en'` server-side. An account with nothing
filled in still returns a complete profile object — which is why "has a profile"
is judged on the name/DOB/gender fields, not on the object's presence.

`dateOfBirth` is a calendar date (`YYYY-MM-DD`), not a timestamp; `createdAt`
and `lastLoginAt` are ISO 8601 UTC. They are formatted differently for that
reason — see `src/utils/format.ts`.

### Editing

`PATCH /api/v1/users/me/profile` is a **partial** update covering six fields:
`firstName`, `lastName`, `dateOfBirth`, `gender`, `profileImageFileId`,
`languageCode`. It returns the updated profile only, so the cached user is
patched in place rather than refetched. Only changed fields are sent; sending
`null` clears a field. Identity fields (`phoneNumber`, `email`, `status`,
`roles`, `referralCode`, …) are refused with 400 `IMMUTABLE_FIELD`.

**This one endpoint answers validation errors in two different formats**, and
which one you get depends on where the request dies:

| Failure                             | Caught by              | Detail shape                   |
| ----------------------------------- | ---------------------- | ------------------------------ |
| `gender`/`languageCode` not in enum | Fastify JSON schema    | `{ instancePath, message, … }` |
| bad name, under-age date of birth   | Zod, in the controller | `{ field, code }`              |
| identity field sent                 | controller pre-check   | `{ field, code: 'IMMUTABLE' }` |

`ApiError.validationErrors` normalizes all three to `{ path, message, code? }`.
`code` is only present for the users-module shape, which sends a machine code
(`AGE_BELOW_MINIMUM`, `REQUIRED`, `NOT_ALLOWED`, …) rather than a sentence;
`ProfileForm` maps those to readable text and falls back to the backend's own
message for the Fastify shape.

## Profile photo

The avatar is a real three-step upload, owned by `src/files/`:

```
POST /api/v1/files            reserve a row, get a presigned PUT   (Idempotency-Key)
PUT  <presigned url>          bytes go straight to the bucket      (not via apiClient)
POST /api/v1/files/:id/complete   backend verifies and commits it as READY
PATCH /api/v1/users/me/profile    { profileImageFileId } attaches it
```

The file is attached only after the backend marks it READY, so a failed
transfer never leaves a dangling reference. Attaching a new image supersedes
the previous one server-side and releases it to the retention job.

Display uses `GET /api/v1/files/:id/url`, a presigned URL that lives 600s
(`policy.readTtlSeconds`); `useFileUrl` refetches a minute before it expires so
a long-open page never shows a broken image.

The browser checks type, size and pixel dimensions before requesting a slot, so
a doomed 5 MB PUT is never sent — but the backend re-checks all of it and stays
authoritative. It also refuses images carrying **EXIF GPS data**, which is the
most likely failure for a photo straight off a phone; that error is worded
specifically rather than shown as a raw code.

### What the bucket needs

`STORAGE_PROVIDER=mock` (the dev default) signs URLs for
`https://mock-storage.local`, a host that does not exist — steps 1, 3 and 4 work
but the byte transfer cannot. For real uploads the backend needs S3 configured:

| Variable                                              | Note                                              |
| ----------------------------------------------------- | ------------------------------------------------- |
| `STORAGE_PROVIDER=s3`                                 |                                                   |
| `STORAGE_BUCKET`                                      | the trusted bucket reads are served from          |
| `STORAGE_QUARANTINE_BUCKET`                           | **must differ** — uploads land here until scanned |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` |                                                   |
| `STORAGE_REGION`                                      |                                                   |

The **quarantine bucket must allow `PUT` from the frontend origin via CORS**, or
the browser transfer fails with `STORAGE_UNREACHABLE`. Presigned `GET`s used in
`<img>` need no CORS. Never put these credentials in a `VITE_*` variable — the
frontend never talks to the bucket except through a URL the backend signs.

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Objects land in the quarantine bucket and are copied into the trusted bucket
only once the backend has verified them; reads are served from trusted. A key
that is still in quarantine means the upload never completed.

## Default avatars

With no photo uploaded, `DefaultAvatar` draws an illustrated figure as inline
SVG — no image request, no dependency, crisp at any size. The silhouette follows
`profile.gender`: distinct hair for `MALE` and `FEMALE`, and a neutral figure for
`OTHER`, `PREFER_NOT_TO_SAY` and unset, rather than forcing everyone into one of
two. The palette is seeded from the user id, so two people of the same gender do
not get identical avatars. It also covers the moment before the presigned URL
resolves and any image that fails to load.

### User routes deferred to later modules

Present on the backend, deliberately not implemented here:

| Route                                           | Belongs to          |
| ----------------------------------------------- | ------------------- |
| `POST /api/v1/users/me/phone/change`, `/verify` | phone change flow   |
| `/api/v1/users/me/emergency-contacts` (CRUD)    | later module        |
| `/api/v1/users/me/saved-places` (CRUD)          | later module        |
| `POST /api/v1/users/me/deactivate`              | account lifecycle   |
| `POST /api/v1/users/me/delete-request`          | account lifecycle   |
| `/api/v1/auth/me/sessions`, `/me/devices`       | session/device mgmt |

## Layout

```
src/
  api/         HTTP client, error normalization, health check
  auth/        OTP login, session state, route guard
  user/        Current user query, profile page
  app/         App shell, providers, router
  config/      Typed environment access
  components/  Shared UI
  layouts/     Page chrome
  pages/       Route components
  lib/         API client and other integrations (empty)
  types/       Shared types (empty)
  utils/       Helpers (empty)
```

## Conventions

- Modules stay isolated; nothing cross-imports another module's internals.
- No `fetch` inside components — calls live in `lib/`, consumed through TanStack Query hooks.
- No global state until a second consumer actually needs it.

## Status

Foundation only. Every route renders a placeholder; no backend calls exist yet.
