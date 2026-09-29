# Golden notification payload fixtures

`contract-v1.json` is the **single source of truth** for the FCM `data` payload
this backend emits (spec §19.1). It exists so the mismatch that shipped once —
the backend sending `eventType` while the customer app read `type`, making every
deep link resolve to a fallback screen — cannot recur silently.

## What asserts against it

| Consumer     | Where                                                            | Asserts                                                                          |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Backend      | `tests/unit/notifications/notification-payload-contract.test.ts` | The consumer emits exactly these keys, with exactly these types, for every event |
| Customer app | Phase 2                                                          | Its router resolves each fixture to the intended screen                          |
| Driver app   | Phase 3                                                          | Its offer handler hydrates from `dispatchId` and honours `expiresAt`             |

Both apps are intended to consume this file **by copy, not by hand** — a CI step
should pull it into each app's test fixtures. Until Phases 2 and 3 land, only the
backend asserts against it, so it is one-sided protection.

## Rules

- Every value is a **string**. FCM rejects numbers, booleans, objects and null.
- A conditional id that does not apply is **absent**, never `""`. An empty
  `dispatchId` is how a stale push came to present an arbitrary live offer.
- Adding a field is a minor change; `v` stays `"1"` and clients ignore unknown
  keys. Removing or re-typing a field requires a `v` bump and a release in which
  both versions are emitted.
- `ids` in the fixture records which conditional keys are expected for that
  event, not literal values — the values are generated per test.
