import type { RateLimitOptions } from '../../plugins/rate-limit/rate-limit.plugin.js';
export const rateLimits = Object.freeze({
  otpVerify: Object.freeze<RateLimitOptions>({
    scope: 'rl:otp-verify',
    limit: Number(process.env.RL_OTP_VERIFY_LIMIT ?? 10),
    windowSeconds: Number(process.env.RL_OTP_VERIFY_WINDOW ?? 900),
    keyBy: 'ip',
  }),
  otpSend: Object.freeze<RateLimitOptions>({
    scope: 'rl:otp-send',
    limit: Number(process.env.RL_OTP_SEND_LIMIT ?? 20),
    windowSeconds: Number(process.env.RL_OTP_SEND_WINDOW ?? 3600),
    keyBy: 'ip',
  }),
  tokenRefresh: Object.freeze<RateLimitOptions>({
    scope: 'rl:token-refresh',
    limit: Number(process.env.RL_REFRESH_LIMIT ?? 30),
    windowSeconds: Number(process.env.RL_REFRESH_WINDOW ?? 900),
    keyBy: 'ip',
  }),
  fileUpload: Object.freeze<RateLimitOptions>({
    scope: 'rl:file-upload',
    limit: Number(process.env.RL_FILE_UPLOAD_LIMIT ?? 30),
    windowSeconds: Number(process.env.RL_FILE_UPLOAD_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  payment: Object.freeze<RateLimitOptions>({
    scope: 'rl:payment',
    limit: Number(process.env.RL_PAYMENT_LIMIT ?? 20),
    windowSeconds: Number(process.env.RL_PAYMENT_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  /// 005 T043: the app polls `GET /payments/intents/:id` after checkout, so it
  /// gets its own bucket instead of sharing the 20/h `rl:payment` one (TD-5).
  paymentStatus: Object.freeze<RateLimitOptions>({
    scope: 'rl:payment-status',
    limit: Number(process.env.RL_PAYMENT_STATUS_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_PAYMENT_STATUS_WINDOW ?? 60),
    keyBy: 'user',
  }),
  webhook: Object.freeze<RateLimitOptions>({
    scope: 'rl:webhook',
    limit: Number(process.env.RL_WEBHOOK_LIMIT ?? 600),
    windowSeconds: Number(process.env.RL_WEBHOOK_WINDOW ?? 60),
    keyBy: 'ip',
    onStoreError: 'open',
  }),
  rideWrite: Object.freeze<RateLimitOptions>({
    scope: 'rl:ride-write',
    limit: Number(process.env.RL_RIDE_WRITE_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_RIDE_WRITE_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  supportWrite: Object.freeze<RateLimitOptions>({
    scope: 'rl:support-write',
    limit: Number(process.env.RL_SUPPORT_WRITE_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_SUPPORT_WRITE_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  driverLocation: Object.freeze<RateLimitOptions>({
    scope: 'rl:driver-location',
    limit: Number(process.env.RL_DRIVER_LOCATION_LIMIT ?? 120),
    windowSeconds: Number(process.env.RL_DRIVER_LOCATION_WINDOW ?? 60),
    keyBy: 'user',
  }),
  /// Map refetches on pan/zoom settle and every 60s; this leaves headroom for
  /// real use while capping a client that loops.
  driverMapZones: Object.freeze<RateLimitOptions>({
    scope: 'rl:driver-map-zones',
    limit: Number(process.env.RL_DRIVER_MAP_ZONES_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_DRIVER_MAP_ZONES_WINDOW ?? 60),
    keyBy: 'user',
  }),
  adminLogin: Object.freeze<RateLimitOptions>({
    scope: 'rl:admin-login',
    limit: Number(process.env.RL_ADMIN_LOGIN_LIMIT ?? 10),
    windowSeconds: Number(process.env.RL_ADMIN_LOGIN_WINDOW ?? 900),
    keyBy: 'ip',
  }),
  mapsSearch: Object.freeze<RateLimitOptions>({
    scope: 'rl:maps-search',
    limit: Number(process.env.RL_MAPS_SEARCH_LIMIT ?? 120),
    windowSeconds: Number(process.env.RL_MAPS_SEARCH_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  mapsRoute: Object.freeze<RateLimitOptions>({
    scope: 'rl:maps-route',
    limit: Number(process.env.RL_MAPS_ROUTE_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_MAPS_ROUTE_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  /// Public trip-tracking link. The tracker page polls it for the live position,
  /// so this leaves room for a few family members behind one home IP while
  /// capping anyone hammering or sweeping the endpoint.
  rideShareView: Object.freeze<RateLimitOptions>({
    scope: 'rl:ride-share-view',
    limit: Number(process.env.RL_RIDE_SHARE_VIEW_LIMIT ?? 120),
    windowSeconds: Number(process.env.RL_RIDE_SHARE_VIEW_WINDOW ?? 60),
    keyBy: 'ip',
  }),
  appConfig: Object.freeze<RateLimitOptions>({
    scope: 'rl:app-config',
    limit: Number(process.env.RL_APP_CONFIG_LIMIT ?? 120),
    windowSeconds: Number(process.env.RL_APP_CONFIG_WINDOW ?? 3600),
    keyBy: 'ip',
  }),
});
export type RateLimits = typeof rateLimits;
