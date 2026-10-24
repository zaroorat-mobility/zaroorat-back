# T044 review package: `react-native-razorpay` in the Driver App

**Prepared**: 2026-10-22, on the Owner's T044 decision of the same day. That decision authorized **preparation only**.

**Status**:

- **Not applied.** The real Driver App (`zaroorat_driver_production_app`, branch `fix_ui`, HEAD `3b6f24d`) is unchanged.
- **No approval is recorded.** The four approvals that must come first are listed as **Pending** in [decisions.md §2d](./decisions.md#2d-t044-driver-app-integration-approvals-pending).

**What this package holds**:

1. The exact patch.
2. The lockfile sequencing decision.
3. The security and product checklist.
4. The evidence.
5. The procedure to follow after approval.
6. The blockers.

## 1. The patch

**File**: [`t044-driver-app.patch`](./t044-driver-app.patch), sha256 `3ccb464adfbc2e21…`. It is the reviewed diff, byte for byte.

- It was produced from the spike worktree `zaroorat_driver_rzp_spike` (branch `spike/t005-razorpay-sdk`, also based on `3b6f24d`).
- `git apply --check` passes against the real app's current working tree. That tree holds other people's uncommitted UI work, and the patch touches none of their files.

| File                                           | Change                                                                                                              | Why                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                 | `"react-native-razorpay": "3.0.0"`                                                                                  | Exact pin: no range, no `^`. The npm integrity hash matches the registry.                                                                                                                                                                                                               |
| `app.json`                                     | Adds `"./plugins/withRazorpay"` to `plugins`                                                                        | Registers the config plugin.                                                                                                                                                                                                                                                            |
| `plugins/withRazorpay.js` (new)                | Appends a Gradle rule to the generated `android/build.gradle` that pins `com.razorpay:standard-core` to **1.7.20**. | `com.razorpay:checkout:1.6.41` declares `standard-core:LATEST`, so without the pin every fresh dependency resolution could ship a different SDK. The plugin throws on a non-Groovy root build file instead of building unpinned. It is idempotent: a marker line stops a second append. |
| `plugins/__tests__/withRazorpay.test.ts` (new) | `node:test`, 2 tests                                                                                                | Pin appended once; a second application changes nothing; a non-Groovy file is refused (TM-18).                                                                                                                                                                                          |
| `react-native-razorpay.d.ts` (new)             | Module declaration                                                                                                  | The SDK ships no `types` entry, so under the app's `strict` tsconfig the import fails with TS7016. Proven with a probe import.                                                                                                                                                          |

**Not in the patch**:

- **The lockfile.** It is regenerated (§2).
- **iOS `LSApplicationQueriesSchemes`.** Android only for now.
- **Any checkout code.** That is T045–T049.
- **Any extra manifest or ProGuard entries.** The SDK's own artifacts already provide them (§3).

## 2. Lockfile sequencing: a decision for the app lockfile owner

**Today**:

- The real app's `package-lock.json` has one uncommitted change, made 2026-10-16 20:28: a trailing newline at the end of the file (+1/−1). It changes no dependency or version.
- plan.md (T006 record) lists the file's coordinator as "Owner to name". The last committer is Wasi Mirza (2026-10-07).
- The recorded rule is "regenerated by T044 only after the other change is committed".

**npm writes that same trailing newline itself.** In the spike, adding the SDK produced exactly that hunk plus the new entries.

| Option                                    | What happens                                                                                                                   | T044 lockfile diff                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **A. Separate first** (the recorded rule) | The lockfile owner commits, or deliberately keeps, the newline change on its own. T044 then runs `npm install` on top of it.   | +11: the root dependency line and the `node_modules/react-native-razorpay` entry |
| **B. Included**                           | T044's install writes the newline as part of the coordinated dependency change. plan.md's sequencing rule is amended to match. | +12/−1                                                                           |

**Recommendation: A.** It is the rule already recorded, it keeps the other person's change attributable, and it costs one trivial commit by its owner. Either way, the decision and the owner's name go in decisions.md §2d.

## 3. Security and product checklist

**Evidence**: the merged and packaged manifests of the spike builds (§4).

**Sources**:

- `com.razorpay:standard-core:1.7.20`, `com.razorpay:core:1.0.20` and `:react-native-razorpay`.
- None of these entries is written by our code. Removing any of them needs `tools:node="remove"` in the plugin, and may break the SDK.

**Recording a response.** Responses are collected in [t044-approval-worksheet.md](./t044-approval-worksheet.md) §3, which has separate columns for the security reviewer and the product owner (**Accept**, **Accept with conditions** or **Reject**, with name, role, date, rationale and conditions). The last column below is no longer used. When all nine items are answered, T044-A3 in decisions.md §2d records the outcome. The recommended defaults are proposals only.

| ID  | Item                                                                                        | Source                                 | What it is                                                                                                                                                                                                                                                         | Questions for the reviewer                                                                                                                                                                                                | Recommended default                                                                                                                                                                                                                                                                                                                                           | Decision (name, role, date, conditions) |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| S1  | **Exported `com.razorpay.DeeplinkActivity`**                                                | core 1.0.20                            | `exported="true"`, VIEW + BROWSABLE, `razorpay://com.zaroorat.driver`. Any app or web link can launch it.                                                                                                                                                          | What does it accept and act on? (Ask Razorpay through T008.) Can a hostile launch change app state?                                                                                                                       | **Accept, with a Stage 2 hostile-launch test**: `adb shell am start -a android.intent.action.VIEW -d "razorpay://com.zaroorat.driver/x"` with no checkout open must cause no crash and no state change. Removing it risks breaking app-return flows. In any case no client-side result is ever proof of payment: backend verify and status decide (TD-4, C8). |                                         |
| S2  | **Startup initializers** `com.razorpay.RazorpayInitializer`, `com.razorpay.CoreInitializer` | standard-core (via `androidx.startup`) | Razorpay code runs at **every app start**, before any checkout and even with both payment flags OFF.                                                                                                                                                               | What runs, and does any data or network call leave the device at startup? (The `rzp.device_token.share` query suggests a device-token mechanism.) Does the privacy policy need a disclosure? What is the cold-start cost? | **Accept pending Razorpay's answer**, and measure cold start on the device. Remove only if Razorpay confirms on-demand initialization works.                                                                                                                                                                                                                  |                                         |
| S3  | **Package-visibility `<queries>`**                                                          | standard-core; core                    | `VIEW scheme="*"` (`*/*`), VIEW + BROWSABLE `upi://pay`, `MAIN`, `SEND */*`, `rzp.device_token.share`; plus `VIEW upi` and `VIEW credpay`. Together they make most launchable apps visible to the SDK.                                                             | Is installed-app information transmitted? Does it meet Play's package-visibility and user-data policies? (Intent-based queries need no `QUERY_ALL_PACKAGES` declaration.)                                                 | **Accept**: UPI app discovery needs it. Depends on the answer to S2.                                                                                                                                                                                                                                                                                          |                                         |
| S4  | **`android.permission.NFC`**                                                                | standard-core                          | Normal permission, granted at install. `uses-feature android.hardware.nfc required="false"`, so Play does not filter devices.                                                                                                                                      | Is it acceptable to list it to drivers?                                                                                                                                                                                   | **Accept**, and update the Play listing.                                                                                                                                                                                                                                                                                                                      |                                         |
| S5  | **`android.permission.READ_BASIC_PHONE_STATE`**                                             | core 1.0.20                            | Normal permission (API 33+), no prompt. Basic telephony state, not device identifiers or the phone number.                                                                                                                                                         | Data-safety form impact if anything leaves the device.                                                                                                                                                                    | **Accept**, after the data-safety review.                                                                                                                                                                                                                                                                                                                     |                                         |
| S6  | Other components                                                                            | standard-core; core                    | `CheckoutActivity` (`exported="false"`, `CheckoutTheme`), `MagicXActivity` (`exported="false"`, translucent), `UpiChooserSelectionReceiver` (`exported="false"`).                                                                                                  | Check `CheckoutActivity` visually with edge-to-edge on (target SDK 36) on the device.                                                                                                                                     | **Accept**                                                                                                                                                                                                                                                                                                                                                    |                                         |
| S7  | R8 / minification                                                                           | standard-core consumer rules           | `-keep class com.razorpay.** {*;}`, `onPayment*`, R classes, `@JavascriptInterface`. No missing rules. Razorpay classes stay unobfuscated (a size cost only).                                                                                                      | —                                                                                                                                                                                                                         | **Accept**; no app rules needed.                                                                                                                                                                                                                                                                                                                              |                                         |
| S8  | Supply chain                                                                                | npm, Maven Central                     | The npm integrity hash matches the registry. `standard-core` is pinned by the plugin. The published tarball also contains stray build output (stale Old-Architecture classes, `.gradle`, `.idea`, `.claude/settings.local.json`); none of it is used by our build. | Upgrade policy for the pin.                                                                                                                                                                                               | **Accept.** Bump `STANDARD_CORE_VERSION` only after re-inspecting the new version's manifest and rules.                                                                                                                                                                                                                                                       |                                         |
| S9  | Play Console and privacy                                                                    | —                                      | New third-party SDK and new permissions.                                                                                                                                                                                                                           | Data safety form, permission list, privacy policy.                                                                                                                                                                        | Update before any release containing the SDK.                                                                                                                                                                                                                                                                                                                 |                                         |

## 4. Evidence

**Spike worktree**: `C:\dev\Zaroorat_production\zaroorat_driver_rzp_spike`, branch `spike/t005-razorpay-sdk`. **Evidence folder**: its `t005-evidence/`, which is untracked.

**Stage 1 (2026-10-22 09:20–20:55)**, all on the isolated worktree:

- `npm ci`: 926 packages; the lockfile was unchanged by it.
- Prebuild: `newArchEnabled=true`.
- **Debug build**: successful (the first attempt failed on a DNS error for `dl.google.com`).
- **Release build with R8**: successful on attempt 5. Two attempts were killed by Claude session restarts, one failed on DNS, and one failed on a quoting error in the command.
- The logs are in `t005-evidence/*.txt`.

**Lost and rebuilt**:

- The Stage 1 APKs and the files generated under `android/` were **lost on 2026-10-22 at 21:26**. A later `expo prebuild` **regenerated the whole `android/` folder**: a prebuild without `--clean` does not preserve build outputs here.
- They are rebuilt from the **exact patch above** into `t005-evidence/rebuild/`, outside `android/`. Results: §4a.

**Plugin checks on the final code**:

- `withRazorpay.test.ts`: 2/2.
- ESLint is clean on the 3 new files, and `tsc --noEmit` exits 0.
- Two repeated prebuilds each produce exactly **one** pin block.

**Secret scan** (2026-10-22):

- The patch and every evidence log were checked for Razorpay, Stripe and Google key shapes, private keys, secret, password and token assignments, Bearer tokens, and database URLs with credentials. Result: **0 hits**.
- The patch also has 0 hits for the broad words `rzp_`, `secret`, `password`, `token` and `BEGIN`.
- No `.env` or `google-services.json` was used in any build.

### 4a. Rebuild of the exact patch (2026-10-22 21:48–22:28)

**How it ran**:

- Spike worktree, generated with the final plugin. Detached script: `t005-evidence/run-rebuild.cmd`.
- Single ABI `arm64-v8a`, `--max-workers=2 --no-daemon`, no `.env` and no credentials.
- The release build is signed with the template's debug keystore, so it is not distributable.

| Step                                                                           | Result                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debug: `:app:assembleDebug`                                                    | **BUILD SUCCESSFUL** in 15 min. `app-debug.apk` is 90,777,364 bytes.                                                                                                                                                                         |
| Release: `:app:assembleRelease` + `-Pandroid.enableMinifyInReleaseBuilds=true` | **BUILD SUCCESSFUL** in 23 min 5 s. `minifyReleaseWithR8` ran; no `missing_rules.txt`. `app-release.apk` is 53,547,465 bytes.                                                                                                                |
| `dependencyInsight` (`releaseRuntimeClasspath`)                                | `com.razorpay:standard-core:1.7.20`, "Selected by rule: checkout:1.6.41 declares standard-core:LATEST"                                                                                                                                       |
| Release dex (3 files after R8)                                                 | `com.razorpay.rn.RazorpayModule` extends `NativeRazorpayCheckoutSpec` (a TurboModule), name unchanged, in `classes2.dex`                                                                                                                     |
| Packaged manifests (debug and release)                                         | Exactly the §3 items: `CheckoutActivity`, `DeeplinkActivity` (`exported=true`, `razorpay://com.zaroorat.driver`), `MagicXActivity`, `UpiChooserSelectionReceiver`, `RazorpayInitializer`, `CoreInitializer`, `NFC`, `READ_BASIC_PHONE_STATE` |
| R8 configuration                                                               | Includes standard-core's `-keep class com.razorpay.** {*;}`                                                                                                                                                                                  |
| Secret scan                                                                    | All 39 text evidence files: 0 hits. Release JS bundle (`index.android.bundle`, 5.67 MB): 0 Razorpay, Stripe, Google or private-key patterns.                                                                                                 |

**One false positive was resolved**: a broad `pwd=` pattern matched compressed bytes inside `app-debug.apk`. The match was 64 bytes, only 18 of them alphanumeric, and the APK's uncompressed contents have 0 matches.

**Saved in `t005-evidence/rebuild/`**: both APKs, the debug and release merged manifests, both merger reports, the packaged-manifest dumps, the R8 configuration and the build logs.

**This proves compilation and packaging only.** Runtime behaviour is **NOT TESTED**: no physical device was available.

## 5. After approval: applying it to the real app

This runs only after all four §2d rows are approved.

1. **Baseline.** Record the real tree's status and hashes, as done on 2026-10-22: HEAD, diff hash, untracked-files hash, lockfile, `package.json`, `app.json`.
2. **Back up `android/`.** `android/` is git-ignored, but it may hold local edits; for example, `android/build.gradle` is dated 2026-10-16 22:03. A prebuild regenerates it, so copy it to `_wip-backups/` first.
3. **Apply the patch**: `git apply t044-driver-app.patch`.
4. **Regenerate the lockfile**: `npm install --no-audit --no-fund`, which reads the pinned `package.json`, following the sequencing chosen in §2. Check that the lockfile diff matches the expected size.
5. **Checks**:
   - `npx tsc --noEmit`;
   - `npx eslint` on the touched files;
   - `../zaroorat-back/node_modules/.bin/tsx --test plugins/__tests__/withRazorpay.test.ts`.
6. **Prebuild**: `CI=1 npx expo prebuild --platform android --clean --no-install`. Check `newArchEnabled=true` and exactly one pin block.
7. **Builds**:
   - Debug: `gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a`.
   - Release: `gradlew :app:assembleRelease "-PreactNativeArchitectures=arm64-v8a" "-Pandroid.enableMinifyInReleaseBuilds=true"`.
   - Launch them **detached**: they outlast Claude sessions.
   - Copy the APKs, merged manifests, merger reports and the R8 configuration **out of `android/`** at once.
8. **Verify**:
   - `dependencyInsight` shows `standard-core:1.7.20` "Selected by rule".
   - The merged manifest matches §3.
   - `PackageList.java` and `autolinking.cpp` register `RazorpayPackage` / `RNRazorpayCheckoutSpec`.
   - The final source diff equals the baseline plus the 5 files and the lockfile.
9. **Keep it local**: nothing is committed, pushed or uploaded to EAS, and both payment flags stay OFF.

## 6. Blockers

**Before applying**: the four decisions in decisions.md §2d.

**Before any device checkout test (Stage 2)**:

- A physical Android device. None has been available, so runtime behaviour is **NOT TESTED**.
- A separate Stage 2 authorization.
- T110: rotation of the exposed test keys, verified.
- T002: staging Test Mode setup and webhook evidence.
- The answers to the S1/S2 questions.

**Before any payment test or activation**:

- T045–T049: checkout service; one idempotency key per attempt (C8 — today `client.ts` makes a new key per request); verify; status polling; attempt store.
- The payment flags stay OFF until then.

**Update 2026-10-23**: the attempt store, the explicit attempt key, status polling, the status screen, recharge-option chips and launch/foreground recovery are now in the real Driver App (uncommitted, JS only; see §7.2). T045 (native checkout) and the call to verify after it are not.

## 7. T045 checkout integration plan (prepared 2026-10-23; not implemented)

**Status**: plan only. Nothing here is implemented until T044-A1…A4 (decisions.md §2d) are recorded. Facts below are cited to repository code, the reviewed patch or the inspected SDK artifacts; anything else is listed in §7.5 as unresolved.

### 7.1 Dependency and native configuration (the reviewed patch, §1)

- **JS package**: `react-native-razorpay` **3.0.0**, exact. Its npm integrity hash `sha512-p7bcEJd8…h+g==` matches the registry.
- **Lockfile**: regenerated by `npm install --no-audit --no-fund` after `git apply t044-driver-app.patch`, following the A2 sequencing. Expected diff: +11 lines (A) or +12/−1 (B), §2.
- **Native Android chain**:
  - `com.razorpay:checkout:1.6.41` → `standard-core`, pinned to **1.7.20** by `plugins/withRazorpay.js` (registered in `app.json`) → `com.razorpay:core:1.0.20`.
  - Nothing else is configured by hand: UPI `<queries>`, activities and R8 keep rules come from those artifacts (§3, §4a).
- **New Architecture** stays on; React Native 0.86 cannot turn it off.
- **TypeScript**: `react-native-razorpay.d.ts`.
- **Generated `android/`**: never edited, and never copied from the spike.
- **iOS** (`LSApplicationQueriesSchemes`): out of scope.

### 7.2 Where checkout plugs into the existing app code

Already in the real app:

- **`AddMoneyScreen.handlePay`** creates the intent with the attempt's stored key, saves `intentId`, then opens the status screen. Checkout belongs at its `T045:` comment.
- **`money.ts`**: `RechargeIntent.checkout` (the contract fields) and `verifyPayment(intentId, callback, key)`.
- **`rechargePolicy.ts`**:
  - an attempt with an intent resumes from its status and is never re-created;
  - only SUCCEEDED, EXPIRED or REFUNDED end it.
- **`PaymentStatusScreen`** and **`PaymentRecoveryBridge`**: the backend's `GET /payments/intents/:intentId` is the only source of truth. The wallet is refreshed only on SUCCEEDED.

### 7.3 Launch and callback contract

**Launch** (new `src/services/payments/checkout.ts`):

- **Input**: the recharge response's `checkout` object (`provider`, `keyId`, `orderId`, `amount` in paise, `currency`, `name`, `description`; contracts/http-api.md).
  - `checkout: null` means the provider has no client checkout (the dev mock): no checkout is opened, and the status screen is shown.
- **Options passed to `RazorpayCheckout.open`, and nothing else**: `{ key: keyId, order_id: orderId, amount, currency, name, description }`.
  - No `prefill` (C7, UD-9).
  - The amount and order come only from the backend.
- **One checkout at a time.** The SDK's JS listeners are global (`RazorpayCheckout.js` removes all of them after the first event), so a second `open` would share them. Use an in-flight guard per attempt.
- **Reopening** on resume is allowed only while the backend reports PENDING or FAILED, and only on the **same** order (T046).

**After checkout returns**:

- **Success**: call `verifyPayment(intentId, { razorpayPaymentId, razorpayOrderId, razorpaySignature })`. The body is exactly the route schema: three patterned strings, no extra properties. Then show the status screen, which polls `GET`.
- **Verify is only a prompt** (contract TD-4). The callback never credits anything, never shows "Success" and never refreshes the wallet.
- **Verify errors**:
  - `400 PAYMENT_ORDER_MISMATCH` or `PAYMENT_SIGNATURE_INVALID` → status screen. The backend still settles the payment from the webhook or reconciliation.
  - `503 PAYMENT_GATEWAY_UNAVAILABLE`, `409 IDEMPOTENCY_IN_PROGRESS` or a network failure → status screen with polling. A retry is safe.
  - `404 PAYMENT_NOT_FOUND` → clear the attempt.

### 7.4 Outcomes

Error codes are read from `com.razorpay.Checkout` in `standard-core` 1.7.20 (`javap`).

| Event                                       | SDK signal                                                                                         | App behaviour                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Success                                     | `open()` resolves with the payment data                                                            | Verify, then status                                                                                  |
| Dismissed                                   | `PAYMENT_CANCELED = 0`                                                                             | "Not completed yet" plus a status check; the attempt is kept; never shown as a failure (C8)          |
| Network loss                                | `NETWORK_ERROR = 2`                                                                                | Status check: the payment may still have gone through                                                |
| Invalid options                             | `INVALID_OPTIONS = 3`                                                                              | Treated as a defect: log the code only; status check; attempt kept                                   |
| TLS, incompatible plugin or WebView failure | `6`, `7`, `8`                                                                                      | A device-problem message; status check                                                               |
| Bank or provider decline                    | **No public constant** (U2)                                                                        | Status check; "Failed" only when the backend reports FAILED                                          |
| No event at all                             | `RazorpayModuleImpl.open()` returns silently when there is no current activity or on any exception | `PaymentRecoveryBridge` and the status screen fall back to the backend status on the next foreground |
| App killed mid-payment                      | The activity result is lost                                                                        | Launch recovery re-checks the backend; the webhook or reconciliation settles it server-side          |
| Duplicate callbacks                         | The SDK drops its listeners after the first event                                                  | A per-attempt guard ignores a second one; verify is idempotent per key                               |
| Timeout                                     | No `timeout` option is sent by the backend                                                         | An unpaid order's intent expires server-side; the status screen shows EXPIRED                        |

### 7.5 Unresolved questions

1. **U1 and U2** (research.md):
   - Bridgeless runtime on a physical device.
   - Exact callback payloads, including whether `razorpay_order_id` and `razorpay_signature` are always present. The SDK's own `src/types.ts` marks them optional.
   - The decline code.
2. **Verify idempotency key (needs an Owner decision).**
   - **The conflict.** The contract says the interceptor supplies the key (a fresh one per request). C8 says retries of the same attempt reuse one key.
   - **What the backend does.** It scopes verify by (user, `/payments/intents/verify`, key) and hashes `{ intentId, ...callback }`, with a 24 h TTL by default (`payment.service.ts`, `idempotency.repository.ts`).
     - A second, different callback under the same key → `409 DUPLICATE_IDEMPOTENCY_KEY`.
     - A replay returns the first, possibly stale, answer.
   - **Proposal.** One deterministic key per callback, `${attemptKey}:${razorpayPaymentId}`: retries of the same callback reuse it, and a new payment on the same order gets its own. The key column is an unbounded string.
3. **The Android JS fallback.** The wrapper's `RazorpayEventEmitter` TurboModule exists only on iOS, so Android goes through `NativeModules` (spike). Needs device proof.
4. **S1 and S2 semantics**: `DeeplinkActivity` and the startup initializers (T008 to Razorpay).
5. **Custom-amount bounds** are not exposed by the backend; out-of-range amounts are answered `422 INVALID_RECHARGE_AMOUNT`.

### 7.6 Verification after approval

**Local** (§5, steps 1–9):

- Back up `android/`.
- Apply the patch and regenerate the lockfile.
- `tsc`, ESLint and the app tests, plus new unit tests for the options mapping and the outcome normalisation (pure functions).
- `expo prebuild --clean`; check `newArchEnabled=true` and exactly one pin block.
- Debug build, and release build with R8, launched detached.
- `dependencyInsight` shows 1.7.20.
- The merged manifest matches S1–S9.
- `PackageList` and `autolinking.cpp` register `RazorpayPackage` / `RNRazorpayCheckoutSpec`.

**Physical device (Stage 2, separately authorized; needs T110, T002 and staging Test Mode)**, each test on a debug **and** an R8 release build:

- The module loads and checkout opens on a test order.
- Success → verify → SUCCEEDED, exactly one credit.
- Dismiss → not completed.
- Network loss.
- App killed during checkout → launch recovery.
- UPI app hand-off and visibility.
- S1 hostile deep-link launch.
- S2 cold-start cost.
