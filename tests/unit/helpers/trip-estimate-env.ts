/**
 * Sets the two trip-estimation knobs to values that are not the code defaults,
 * so `trip-estimate.test.ts` can tell "reads the config" apart from "returns
 * the hardcoded 1.3 and 3" — which was the defect.
 *
 * Same first-import mechanics as `cancellation-fee-env.ts`: `pricingConfig` is
 * frozen when `@config` is first imported, and ESM hoists every static import
 * above the module body, so an assignment at the top of the test file would run
 * too late. See that file for the full reasoning.
 */
process.env.RIDE_ROAD_DISTANCE_FACTOR = '2';
process.env.RIDE_MINUTES_PER_KM = '6';
