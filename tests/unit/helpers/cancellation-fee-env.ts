/**
 * Sets `RIDE_DEFAULT_CANCELLATION_FEE` to a value that is not the code default,
 * so `cancellation-fee.test.ts` can tell "reads the config" apart from "returns
 * the literal 50" — which was the defect.
 *
 * It has to be its own module because `rideConfig` is frozen when `@config` is
 * first imported, and ESM hoists every static import above the module body: an
 * assignment written at the top of the test file would run *after* the config
 * it is trying to influence. Imported first, this runs first.
 *
 * Doing it with a lazy `await import()` inside the test instead is what this
 * replaces: that deferred dotenv's startup banner into the middle of the run,
 * which corrupted the test runner's IPC framing and failed the whole file with
 * `Unable to deserialize cloned data`.
 */
process.env.RIDE_DEFAULT_CANCELLATION_FEE = '73';
