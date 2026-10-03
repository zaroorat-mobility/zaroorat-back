/**
 * Operations Dashboard DTO Contracts
 *
 * Defines the strict, typed payload contracts between backend aggregation
 * services and the frontend admin cockpit.
 *
 * Conventions: a value the backend could not measure or compare is `null`,
 * never a stand-in number. "Today" is the IST day so far; "same time yesterday"
 * is the previous IST day up to the same wall-clock time (see dashboard.periods.ts).
 */

// ─── 1. Overview DTO ─────────────────────────────────────────────────────────

export interface DashboardOverviewDto {
  /** Total on-duty drivers (ONLINE + ON_TRIP + BUSY + BREAK) now, from driver_online_status */
  activeDrivers: number;
  /**
   * % change vs drivers on duty at the same time yesterday (driver_shift_logs
   * open at that instant). null when yesterday's count is 0.
   */
  activeDriversChangePct: number | null;
  /** Total drivers currently available for instant dispatch (status = ONLINE) */
  onlineDrivers: number;
  /** Percentage of active drivers currently in ONLINE state (0 when none are active) */
  onlineDriversPctOfActive: number;
  /** Total ongoing ride transactions in progress (ACCEPTED..IN_PROGRESS) */
  ongoingRides: number;
  /**
   * % change vs rides ongoing at the same time yesterday, reconstructed from
   * rides.accepted_at / completed_at / cancelled_at. null when that count is 0.
   */
  ongoingRidesChangePct: number | null;
  /** Unique riders currently in-flight (searching or on trip) */
  inFlightRiders: number;
  /** Rides completed today so far (IST) */
  completedRidesToday: number;
  /** Rides completed yesterday up to the same IST time of day */
  completedRidesYesterday: number;
  /** % change of completedRidesToday vs completedRidesYesterday; null when yesterday is 0 */
  completedRidesChangePct: number | null;
  /** Drivers awaiting verification (PENDING + DOCUMENT_REVIEW), excluding deleted drivers */
  pendingVerifications: number;
  /**
   * Always null: verification status has no history (drivers keep only
   * approved_at), so a past pending count cannot be reconstructed.
   */
  pendingVerificationsChangePct: number | null;
  /** Registered driver accounts, excluding deleted drivers */
  registeredDrivers: number;
  /** Timestamp when the overview snapshot was calculated */
  calculatedAt: string;
}

// ─── 2. Financials DTO ───────────────────────────────────────────────────────

export interface DashboardFinancialsDto {
  /** Platform revenue today (ledger posting date): Subscriptions + Commission + Platform Fees */
  platformRevenueToday: number;
  /** Platform revenue yesterday up to the same IST time of day */
  platformRevenueYesterday: number;
  /** % change vs yesterday at the same time; null when yesterday is 0 */
  platformRevenueChangePct: number | null;

  /** Gross ride value today: fares of rides completed today so far */
  grossRideValueToday: number;
  /** Gross ride value yesterday up to the same IST time of day */
  grossRideValueYesterday: number;
  /** % change vs yesterday at the same time; null when yesterday is 0 */
  grossRideValueChangePct: number | null;

  /**
   * Driver ride collections today: Gross Ride Value minus the commission and
   * platform-fee ledger legs of those same rides (attributed by ride completion
   * date). Subscriptions are strictly NOT deducted. May be negative.
   */
  driverRideCollectionsToday: number;
  /** Driver ride collections yesterday up to the same IST time of day */
  driverRideCollectionsYesterday: number;
  /** % change vs yesterday at the same time; null when yesterday is 0 */
  driverRideCollectionsChangePct: number | null;

  /** Currency symbol / ISO code */
  currency: string;
  /** Timezone used for daily cutoff */
  reportingTimeZone: string;
  /** Timestamp of calculation */
  calculatedAt: string;
}

// ─── 3. Analytics DTOs ───────────────────────────────────────────────────────

export type AnalyticsRange = '7d' | '30d' | '90d';

export interface PlatformRevenueTrendPoint {
  date: string; // e.g. "Sep 23, 2026"
  dayOfWeek: string; // e.g. "Wed"
  dateKey: string; // e.g. "2026-09-23"
  /** Net of CREDIT − DEBIT; may be negative */
  platformRevenue: number;
  rideCommission: number;
  subscriptionRevenue: number;
  platformFees: number;
}

export interface GrossRideValueTrendPoint {
  date: string; // e.g. "Sep 23, 2026"
  dayOfWeek: string; // e.g. "Wed"
  dateKey: string; // e.g. "2026-09-23"
  grossRideValue: number;
  ridesCount: number;
}

/** GET /dashboard/financial-analytics (finance:read): daily financial series for the range. */
export interface DashboardFinancialAnalyticsDto {
  range: AnalyticsRange;
  platformRevenueTrend: PlatformRevenueTrendPoint[];
  grossRideValueTrend: GrossRideValueTrendPoint[];
  reportingTimeZone: string;
  calculatedAt: string;
}

/**
 * Outcomes of today's demand. completed / cancelled / ongoing are rides accepted
 * today (by current status); noDriversFound is ride requests created today that
 * expired without any driver accepting (ride_requests.status = EXPIRED).
 */
export interface RideStatusDistributionDto {
  total: number;
  completed: number;
  completedPct: number;
  cancelled: number;
  cancelledPct: number;
  noDriversFound: number;
  noDriversFoundPct: number;
  ongoing: number;
  ongoingPct: number;
}

export interface RideHourBucketDto {
  hour: number; // 0..23 (IST)
  label: string; // e.g. "12 AM", "4 PM"
  count: number;
  isPeak: boolean;
}

/** GET /dashboard/analytics (operations:read): today's operational analytics (IST). */
export interface DashboardAnalyticsDto {
  rideStatusDistribution: RideStatusDistributionDto;
  /** Rides accepted today, by IST hour of acceptance (24 zero-filled buckets) */
  ridesByHour: RideHourBucketDto[];
  /** [periodStart, periodEnd): today in IST */
  periodStart: string;
  periodEnd: string;
  reportingTimeZone: string;
  calculatedAt: string;
}

// ─── 4. Live Drivers DTO ────────────────────────────────────────────────────

/**
 * LIVE / STALE: on-duty driver whose last GPS fix is within / older than the
 * dispatch staleness threshold (geoConfig.candidateStalenessSeconds).
 * OFFLINE: the driver is off duty. UNKNOWN: on duty but no GPS fix recorded.
 */
export type GpsFreshness = 'LIVE' | 'STALE' | 'OFFLINE' | 'UNKNOWN';

export interface DashboardLiveDriverItemDto {
  id: string;
  driverNumber: string;
  fullName: string;
  phoneNumber: string;
  avatarUrl: string | null;
  status: 'ONLINE' | 'ON_TRIP' | 'BUSY' | 'BREAK' | 'OFFLINE';
  /** From the active vehicle assignment's type; null when no vehicle is assigned */
  mode: 'Car' | 'Auto' | 'Bike' | null;
  vehicle: {
    id: string | null;
    licensePlate: string | null;
    model: string | null;
    typeCode: string;
    typeName: string;
  } | null;
  location: {
    lat: number;
    lng: number;
    address?: string | null;
  } | null;
  /** Last reported speed; null when the fix carried no speed */
  speedKmh: number | null;
  /** Compass heading ("N", "NE", …); null when the fix carried no heading */
  heading: string | null;
  activeTrip: {
    id: string;
    rideCode: string;
    status: string;
  } | null;
  recordedAt: string | null;
  gpsFreshness: GpsFreshness;
  gpsLagSeconds: number | null;
  lastUpdateText: string;
}

export interface DashboardLiveDriversResponseDto {
  /** Non-deleted drivers; equals the sum of the five status counts */
  totalDrivers: number;
  onlineCount: number;
  onTripCount: number;
  busyCount: number;
  breakCount: number;
  /** OFFLINE status, including drivers who have never gone online */
  offlineCount: number;
  /** GPS age (seconds) above which an on-duty driver is STALE */
  gpsStaleAfterSec: number;
  /** On-duty drivers by default (or the requested status), freshest GPS first */
  drivers: DashboardLiveDriverItemDto[];
  calculatedAt: string;
}

// ─── 5. Activity Timeline DTO ───────────────────────────────────────────────

export type DashboardActivityType =
  | 'DRIVER_REGISTERED'
  | 'KYC_APPROVED'
  | 'DRIVER_VERIFIED'
  | 'DRIVER_REJECTED'
  | 'RIDE_COMPLETED'
  | 'RIDE_CANCELLED'
  | 'PAYMENT_SETTLED'
  | 'VEHICLE_ADDED'
  | 'HIGH_CANCELLATION_RATE'
  | 'SYSTEM_ALERT'
  | 'ADMIN_ACTION';

export interface DashboardActivityItemDto {
  /** Globally unique and sortable: "<source>:<uuid>" */
  id: string;
  type: DashboardActivityType;
  title: string;
  description: string;
  entityType?: 'driver' | 'ride' | 'vehicle' | 'payment' | 'system';
  entityId?: string;
  actorName?: string;
  timestamp: string; // ISO 8601
  timeAgoText: string;
  metadata?: Record<string, unknown>;
}

export interface DashboardActivityResponseDto {
  activities: DashboardActivityItemDto[];
  hasMore: boolean;
  /** Opaque cursor for the next page ("<timestamp>|<id>"); null on the last page */
  nextCursor: string | null;
  calculatedAt: string;
}

// ─── 6. System Health DTO ───────────────────────────────────────────────────

export interface DashboardHealthDto {
  /** Round-trip time of `SELECT 1` against PostgreSQL; null when the probe failed */
  databaseLatencyMs: number | null;
  databaseStatus: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  /** Socket.IO connections on the API instance that served this request; null when unknown */
  websocketConnections: number | null;
  websocketStatus: 'HEALTHY' | 'DOWN' | 'DISABLED' | 'UNAVAILABLE';
  redisStatus: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  /** Failed jobs currently retained across managed BullMQ queues; null when not measured */
  failedQueueJobs: number | null;
  /** % of notifications created in the last 24 h and already final that succeeded (SENT/DELIVERED/READ); null with no data */
  notificationSuccessRate: number | null;
  notificationStatus: 'HEALTHY' | 'DEGRADED' | 'NO_DATA' | 'UNAVAILABLE';
  /** Age (s) of the most recent GPS fix from any on-duty driver; null with no data */
  gpsFreshnessSec: number | null;
  gpsFreshnessStatus: 'LIVE' | 'STALE' | 'NO_DATA' | 'UNAVAILABLE';
  /** FAILED share (%) of online payment transactions that settled in the last 24 h; null with no data */
  paymentFailureRate24h: number | null;
  paymentFailureStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'NO_DATA' | 'UNAVAILABLE';
  /** Aggregate of the statuses above (rules in dashboard.health.ts) */
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  timestamp: string;
}
