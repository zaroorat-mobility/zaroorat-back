# Volume 8 — Mobile Architecture

> How the Expo / React Native app is built. One codebase serves **both rider and driver** experiences
> (Volume 4, ADR on Expo). This volume covers structure, navigation, state, and — most importantly
> for this market — the **offline-resilience** layer that keeps the app usable on unreliable
> connectivity (A6.1).

**Owner:** Engineering (Mobile) · **Last reviewed:** 2026-07-06

---

## Contents

| Doc                                                      | Topic                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [01_project-structure.md](01_project-structure.md)       | Folder layout, feature-slicing, navigation (Expo Router)             |
| [02_state-management.md](02_state-management.md)         | React Query (server state) + Zustand (local) — when to use which     |
| [03_offline-resilience.md](03_offline-resilience.md)     | The action queue, idempotency, reconnect/resync — A6.1 on the client |
| [04_maps-location.md](04_maps-location.md)               | Maps, foreground/background location, permissions, battery           |
| [05_push-deeplinking-ota.md](05_push-deeplinking-ota.md) | Push notifications, deep links, OTA updates, app config/env          |

---

## Principles

1. **One codebase, two roles.** Rider and driver share components, API client, and infrastructure;
   they differ in navigation stacks and a few role-specific features. Role comes from the auth token
   (Volume 5). No separate app, no forked code.
2. **The server is the source of truth; the app is a cache + queue.** The app never invents trip or
   money state — it renders server state (React Query) and queues intents (offline layer) that the
   server confirms. This is the heart of resilience (A6.1).
3. **Server state ≠ client state.** Server data lives in **React Query**; ephemeral UI/session state
   lives in **Zustand** or component state. They are never conflated (Volume 1 rule).
4. **Types come from the contract.** All API types/functions are the **generated client** from
   `packages/api-contracts` (Volume 7). No hand-written API types.
5. **Design for the low end.** Mid-range Android, patchy data, small payloads, big tap targets for
   drivers, audible cues (Volume 2 personas, NFR-USE).
6. **Resilience is a layer, not sprinkles.** Offline handling lives in one place (the action queue +
   query cache), not scattered `try/catch` blocks.

---

## Tech choices

| Concern          | Choice                                               | Why                                                     |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Framework        | **Expo (managed) + React Native**, TypeScript strict | one codebase, OTA, native modules (Volume 4)            |
| Navigation       | **Expo Router** (file-based)                         | typed routes, deep-linking for free                     |
| Server state     | **TanStack React Query**                             | caching, retries, background refetch, offline mutations |
| Local state      | **Zustand**                                          | tiny, simple, no boilerplate for UI/session state       |
| Storage          | **MMKV** (fast) + SecureStore for tokens             | fast persistence; secrets in the keychain               |
| Maps             | Expo-compatible maps + provider SDK                  | pickup/drop, live tracking                              |
| Forms/validation | lightweight + shared validators                      | mirror server validation where useful                   |
| API client       | **generated** (`packages/api-contracts`)             | drift-proof (Volume 7)                                  |

## How rider and driver differ (and share)

```
shared:   auth, api client, ui-kit, maps/location, push, offline layer, profile, wallet
rider:    booking flow, fare estimate, live trip tracking, share/SOS
driver:   online/offline, ride offers, navigation handoff, earnings, KYC onboarding
```

Role-specific screens live under role-scoped route groups ([01](01_project-structure.md)); shared
logic lives in `src/` features/lib and `packages/ui-kit`.
