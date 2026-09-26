import type { EventEnvelope } from '../../../src/core/events';

/// F3 parity baseline — the golden table for ride/payment push notifications.
///
/// Every expectation here was pinned against the RideNotificationConsumer as it
/// stood before F3 (ride-notification-consumer-golden.test.ts). The planner and
/// the migrated consumer must reproduce it exactly: same rows, same enqueues,
/// same status writes, same lookups, same counters. Change an expectation only
/// together with a deliberate, reviewed behaviour change.
///
/// Not a test file on its own (no `.test.ts`), so the runner never executes it.

export const EVENT_ID = 'e0000000-0000-4000-8000-000000000001';
export const OCCURRED_AT = '2026-09-25T10:00:00.000Z';

export const RIDE = '10000000-0000-4000-8000-000000000001';
export const RIDE_NO_DRIVER = '10000000-0000-4000-8000-000000000002';
export const RIDE_GHOST_DRIVER = '10000000-0000-4000-8000-000000000003';
export const RIDE_MISSING = '10000000-0000-4000-8000-000000000009';
export const CUSTOMER_USER = '20000000-0000-4000-8000-000000000001';
export const ERASED_USER = '20000000-0000-4000-8000-000000000099';
export const DRIVER = '30000000-0000-4000-8000-000000000001';
export const GHOST_DRIVER = '30000000-0000-4000-8000-000000000009';
export const DRIVER_USER = '40000000-0000-4000-8000-000000000001';
export const DISPATCH = '50000000-0000-4000-8000-000000000001';
export const REQUEST = '60000000-0000-4000-8000-000000000001';
export const FUTURE = '2099-01-01T00:00:00.000Z';
export const PAST = '2020-01-01T00:00:00.000Z';

/// What the lookups can see. `Ride.driverId` is NOT NULL in the schema, so
/// RIDE_NO_DRIVER exists only to pin the consumer's guard; RIDE_GHOST_DRIVER
/// points at a driver with no record.
export const RIDES: Readonly<Record<string, { customerId: string; driverId: string | null }>> = {
  [RIDE]: { customerId: CUSTOMER_USER, driverId: DRIVER },
  [RIDE_NO_DRIVER]: { customerId: CUSTOMER_USER, driverId: null },
  [RIDE_GHOST_DRIVER]: { customerId: CUSTOMER_USER, driverId: GHOST_DRIVER },
};
export const DRIVERS: Readonly<Record<string, { userId: string }>> = {
  [DRIVER]: { userId: DRIVER_USER },
};

/// The ten events the consumer subscribes to.
export const NOTIFICATION_EVENT_TYPES = [
  'ride.dispatch.offered',
  'ride.accepted',
  'ride.driver_arriving',
  'ride.driver_arrived',
  'ride.started',
  'ride.cancelled',
  'ride.completed',
  'ride.request.expired',
  'payment.ride.collected',
  'payment.ride.collection_failed',
] as const;

export interface GoldenFaults {
  /// 1-based ride-lookup call numbers that throw.
  rideLookupFailsOnCall?: number[];
  driverLookupFails?: boolean;
  /// The notification insert for this recipient throws.
  createFailsForUser?: string;
  /// The repository reports every insert as a duplicate.
  createReturnsDuplicate?: boolean;
  enqueueRejects?: boolean;
}

/// Exactly the input handed to `createNotificationWithDelivery`.
export interface GoldenRow {
  userId: string;
  category: 'TRANSACTIONAL';
  priority: 'HIGH' | 'NORMAL';
  eventKey: string;
  idempotencyKey: string;
  title: string;
  body: string;
  data: Record<string, string>;
  referenceType: 'RIDE' | null;
  referenceId: string | null;
  channel: 'PUSH';
}

/// Exactly the arguments handed to `notificationsQueue().add`.
export interface GoldenEnqueue {
  name: 'notification-delivery';
  data: {
    notificationId: string;
    deliveryId: string;
    eventId: string;
    eventType: string;
    userId: string;
    rideId: string | null;
    category: string;
  };
  opts: { jobId: string; priority: number };
}

export type GoldenStatusWrite =
  | { kind: 'delivery'; id: string; input: Record<string, unknown> }
  | { kind: 'notification'; id: string; status: string };

export interface GoldenExpect {
  /// Every lookup attempted, in order, including ones that threw.
  rideLookups: string[];
  driverLookups: string[];
  /// Every insert attempted, in order, including ones that threw. The stub
  /// repository numbers attempts, so attempt n is `notif-n` / `del-n`.
  rows: GoldenRow[];
  enqueues: GoldenEnqueue[];
  statusWrites: GoldenStatusWrite[];
  /// `notification_created` / `notification_enqueue_failed`, summed over labels.
  created: number;
  enqueueFailed: number;
}

export interface GoldenScenario {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  faults: GoldenFaults;
  expect: GoldenExpect;
}

export function envelopeFor(scenario: Pick<GoldenScenario, 'type' | 'data'>): EventEnvelope {
  return {
    eventId: EVENT_ID,
    type: scenario.type,
    version: 1,
    envelopeVersion: 1,
    occurredAt: OCCURRED_AT,
    producer: scenario.type.startsWith('payment.') ? 'payments' : 'rides',
    subject: { userId: null },
    correlation: { requestId: null, sessionId: null },
    data: scenario.data,
  };
}

// ── Expectation builders ─────────────────────────────────────────────────────
//
// Only the parts that never vary are filled in here. Everything a scenario
// decides — recipient, copy, priority, payload ids — is spelled out below.
// G01 is written fully literal, with no builder, as the anchor for these.

function payload(type: string, category: string, ids: Record<string, string>) {
  return {
    v: '1',
    type,
    eventType: type,
    eventId: EVENT_ID,
    timestamp: OCCURRED_AT,
    category,
    ...ids,
  };
}

function row(r: {
  userId: string;
  type: string;
  priority: 'HIGH' | 'NORMAL';
  title: string;
  body: string;
  data: Record<string, string>;
  rideId: string | null;
}): GoldenRow {
  return {
    userId: r.userId,
    category: 'TRANSACTIONAL',
    priority: r.priority,
    eventKey: r.type,
    idempotencyKey: `${EVENT_ID}:${r.type}:${r.userId}:PUSH`,
    title: r.title,
    body: r.body,
    data: r.data,
    referenceType: r.rideId === null ? null : 'RIDE',
    referenceId: r.rideId,
    channel: 'PUSH',
  };
}

/// A customer notification about a ride, with the ride id as its only id.
function rideRow(
  type: string,
  priority: 'HIGH' | 'NORMAL',
  title: string,
  body: string,
  opts: { userId?: string; rideId?: string } = {},
): GoldenRow {
  const rideId = opts.rideId ?? RIDE;
  return row({
    userId: opts.userId ?? CUSTOMER_USER,
    type,
    priority,
    title,
    body,
    data: payload(type, 'TRANSACTIONAL', { rideId }),
    rideId,
  });
}

function enqueue(
  n: number,
  e: { userId: string; type: string; category: string; rideId: string | null; priority: number },
): GoldenEnqueue {
  return {
    name: 'notification-delivery',
    data: {
      notificationId: `notif-${n}`,
      deliveryId: `del-${n}`,
      eventId: EVENT_ID,
      eventType: e.type,
      userId: e.userId,
      rideId: e.rideId,
      category: e.category,
    },
    opts: { jobId: `notif-${n}`, priority: e.priority },
  };
}

function rideEnqueue(n: number, type: string, priority: number, userId = CUSTOMER_USER) {
  return enqueue(n, { userId, type, category: 'TRANSACTIONAL', rideId: RIDE, priority });
}

function scenario(
  id: string,
  name: string,
  type: string,
  data: Record<string, unknown>,
  expect: Partial<GoldenExpect>,
  faults: GoldenFaults = {},
): GoldenScenario {
  return {
    id,
    name,
    type,
    data,
    faults,
    expect: {
      rideLookups: [],
      driverLookups: [],
      rows: [],
      enqueues: [],
      statusWrites: [],
      created: 0,
      enqueueFailed: 0,
      ...expect,
    },
  };
}

// ── Copy, verbatim from the pre-F3 consumer ──────────────────────────────────

const OFFER_TITLE = 'New ride request';
const OFFER_BODY = 'A ride is nearby — open the app to accept.';
const CANCEL_TITLE = 'Ride cancelled';
const CUSTOMER_CANCELLED_BY_DRIVER =
  'Your driver cancelled this trip. Book again and we will find you another driver.';
const CUSTOMER_CANCELLED = 'Your trip has been cancelled.';
const DRIVER_CANCELLED_BY_CUSTOMER = 'The passenger cancelled this trip. You are back online.';
const DRIVER_CANCELLED = 'This trip has been cancelled.';
const EXPIRED_TITLE = 'No drivers available';
const EXPIRED_BODY = 'We could not find a driver for your trip. Please try booking again.';
const COLLECTION_FAILED_TITLE = 'Payment unsuccessful';
const COLLECTION_FAILED_BODY =
  'We could not collect the fare for your last trip. Open the app to settle it.';

const offerData = (expiresAt: unknown) => ({
  dispatchId: DISPATCH,
  requestId: REQUEST,
  driverId: DRIVER,
  expiresAt,
});

function offerRow(expiresAt: string | null): GoldenRow {
  return row({
    userId: DRIVER_USER,
    type: 'ride.dispatch.offered',
    priority: 'HIGH',
    title: OFFER_TITLE,
    body: OFFER_BODY,
    data: payload('ride.dispatch.offered', 'RIDE_OFFER', {
      dispatchId: DISPATCH,
      requestId: REQUEST,
      ...(expiresAt === null ? {} : { expiresAt }),
    }),
    rideId: null,
  });
}

const offerEnqueue = enqueue(1, {
  userId: DRIVER_USER,
  type: 'ride.dispatch.offered',
  category: 'RIDE_OFFER',
  rideId: null,
  priority: 1,
});

/// Both participants of a cancelled RIDE, customer first.
function cancelRows(customerBody: string, driverBody: string): GoldenRow[] {
  return [
    rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, customerBody),
    rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, driverBody, { userId: DRIVER_USER }),
  ];
}

const cancelData = (cancelledBy: unknown, rideId = RIDE) => ({
  rideId,
  cancelledBy,
  toStatus: 'CANCELLED',
});

const startedRow = rideRow(
  'ride.started',
  'NORMAL',
  'Trip started',
  'Your trip is now in progress.',
);

/// Real producer payloads (lifecycle.service.ts, collection.service.ts) for the
/// events that resolve their recipient through the ride.
const RIDE_ID_EVENTS: ReadonlyArray<{ type: string; data: (rideId?: string) => object }> = [
  { type: 'ride.accepted', data: (rideId) => ({ rideId, driverId: DRIVER }) },
  { type: 'ride.driver_arriving', data: (rideId) => ({ rideId, driverId: DRIVER }) },
  { type: 'ride.driver_arrived', data: (rideId) => ({ rideId, driverId: DRIVER }) },
  { type: 'ride.started', data: (rideId) => ({ rideId, driverId: DRIVER }) },
  { type: 'ride.completed', data: (rideId) => ({ rideId, driverId: DRIVER, totalFare: 150 }) },
  { type: 'ride.cancelled', data: (rideId) => ({ rideId, cancelledBy: 'driver' }) },
  {
    type: 'payment.ride.collected',
    data: (rideId) => ({ rideId, customerId: CUSTOMER_USER, amount: 150, method: 'CASH' }),
  },
  {
    type: 'payment.ride.collection_failed',
    data: (rideId) => ({ rideId, customerId: CUSTOMER_USER, amount: 150, willRetry: false }),
  },
];

/// `rideId: undefined` is dropped so the key is genuinely absent.
function withoutUndefined(data: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

// ── The table ────────────────────────────────────────────────────────────────

export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  // ── ride.dispatch.offered (driver) ──
  scenario(
    'G01',
    'offer inside its window notifies the driver',
    'ride.dispatch.offered',
    offerData(FUTURE),
    {
      driverLookups: [DRIVER],
      rows: [
        {
          userId: '40000000-0000-4000-8000-000000000001',
          category: 'TRANSACTIONAL',
          priority: 'HIGH',
          eventKey: 'ride.dispatch.offered',
          idempotencyKey:
            'e0000000-0000-4000-8000-000000000001:ride.dispatch.offered:40000000-0000-4000-8000-000000000001:PUSH',
          title: 'New ride request',
          body: 'A ride is nearby — open the app to accept.',
          data: {
            v: '1',
            type: 'ride.dispatch.offered',
            eventType: 'ride.dispatch.offered',
            eventId: 'e0000000-0000-4000-8000-000000000001',
            timestamp: '2026-09-25T10:00:00.000Z',
            category: 'RIDE_OFFER',
            dispatchId: '50000000-0000-4000-8000-000000000001',
            requestId: '60000000-0000-4000-8000-000000000001',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          referenceType: null,
          referenceId: null,
          channel: 'PUSH',
        },
      ],
      enqueues: [
        {
          name: 'notification-delivery',
          data: {
            notificationId: 'notif-1',
            deliveryId: 'del-1',
            eventId: 'e0000000-0000-4000-8000-000000000001',
            eventType: 'ride.dispatch.offered',
            userId: '40000000-0000-4000-8000-000000000001',
            rideId: null,
            category: 'RIDE_OFFER',
          },
          opts: { jobId: 'notif-1', priority: 1 },
        },
      ],
      created: 1,
    },
  ),
  scenario(
    'G02',
    'offer past its window is recorded FAILED/OFFER_EXPIRED and never enqueued',
    'ride.dispatch.offered',
    offerData(PAST),
    {
      driverLookups: [DRIVER],
      rows: [offerRow(PAST)],
      statusWrites: [
        {
          kind: 'delivery',
          id: 'del-1',
          input: {
            status: 'FAILED',
            errorCode: 'OFFER_EXPIRED',
            failureReason: 'Ride offer expired before its notification was enqueued',
          },
        },
        { kind: 'notification', id: 'notif-1', status: 'FAILED' },
      ],
      created: 1,
    },
  ),
  scenario(
    'G03',
    'offer whose expiresAt is not a string carries no expiresAt and is enqueued',
    'ride.dispatch.offered',
    offerData(4102444800000),
    { driverLookups: [DRIVER], rows: [offerRow(null)], enqueues: [offerEnqueue], created: 1 },
  ),
  scenario(
    'G04',
    'offer without driverId: nothing, no lookup',
    'ride.dispatch.offered',
    {
      dispatchId: DISPATCH,
      requestId: REQUEST,
      expiresAt: FUTURE,
    },
    {},
  ),
  scenario(
    'G05',
    'offer to a driver with no record: nothing',
    'ride.dispatch.offered',
    { ...offerData(FUTURE), driverId: GHOST_DRIVER },
    { driverLookups: [GHOST_DRIVER] },
  ),
  scenario(
    'G06',
    'offer whose driver lookup throws: nothing, and the handler resolves',
    'ride.dispatch.offered',
    offerData(FUTURE),
    { driverLookups: [DRIVER] },
    { driverLookupFails: true },
  ),

  // ── Ride status (customer) ──
  scenario(
    'G07',
    'accepted notifies the customer at HIGH',
    'ride.accepted',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.accepted',
          'HIGH',
          'Driver assigned',
          'Your driver is on the way to your pickup location.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.accepted', 1)],
      created: 1,
    },
  ),
  scenario(
    'G08',
    'driver_arriving notifies the customer at NORMAL',
    'ride.driver_arriving',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.driver_arriving',
          'NORMAL',
          'Your driver is on the way',
          'Your driver has started heading to you.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.driver_arriving', 2)],
      created: 1,
    },
  ),
  scenario(
    'G09',
    'driver_arrived notifies the customer at HIGH',
    'ride.driver_arrived',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.driver_arrived',
          'HIGH',
          'Your driver has arrived',
          'Your driver is waiting at the pickup point.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.driver_arrived', 1)],
      created: 1,
    },
  ),
  scenario(
    'G10',
    'started notifies the customer at NORMAL',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [startedRow],
      enqueues: [rideEnqueue(1, 'ride.started', 2)],
      created: 1,
    },
  ),
  scenario(
    'G11',
    'completed with a numeric fare states it to two decimals',
    'ride.completed',
    { rideId: RIDE, driverId: DRIVER, totalFare: 150 },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.completed',
          'NORMAL',
          'Trip completed',
          'You have arrived at your destination. Fare: ₹150.00.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.completed', 2)],
      created: 1,
    },
  ),
  scenario(
    'G12',
    'completed without a fare omits it',
    'ride.completed',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.completed',
          'NORMAL',
          'Trip completed',
          'You have arrived at your destination.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.completed', 2)],
      created: 1,
    },
  ),
  scenario(
    'G13',
    'completed with a non-numeric fare omits it',
    'ride.completed',
    { rideId: RIDE, driverId: DRIVER, totalFare: '150.00' },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'ride.completed',
          'NORMAL',
          'Trip completed',
          'You have arrived at your destination.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'ride.completed', 2)],
      created: 1,
    },
  ),

  // ── ride.cancelled (customer + driver, independently) ──
  scenario(
    'G14',
    'cancelled by the driver: both told, customer first',
    'ride.cancelled',
    cancelData('driver'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: cancelRows(CUSTOMER_CANCELLED_BY_DRIVER, DRIVER_CANCELLED),
      enqueues: [
        rideEnqueue(1, 'ride.cancelled', 1),
        rideEnqueue(2, 'ride.cancelled', 1, DRIVER_USER),
      ],
      created: 2,
    },
  ),
  scenario('G15', 'cancelled by the customer', 'ride.cancelled', cancelData('customer'), {
    rideLookups: [RIDE, RIDE],
    driverLookups: [DRIVER],
    rows: cancelRows(CUSTOMER_CANCELLED, DRIVER_CANCELLED_BY_CUSTOMER),
    enqueues: [
      rideEnqueue(1, 'ride.cancelled', 1),
      rideEnqueue(2, 'ride.cancelled', 1, DRIVER_USER),
    ],
    created: 2,
  }),
  scenario(
    'G16',
    'cancelled by the system: generic copy for both',
    'ride.cancelled',
    cancelData('system'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: cancelRows(CUSTOMER_CANCELLED, DRIVER_CANCELLED),
      enqueues: [
        rideEnqueue(1, 'ride.cancelled', 1),
        rideEnqueue(2, 'ride.cancelled', 1, DRIVER_USER),
      ],
      created: 2,
    },
  ),
  scenario(
    'G17',
    'cancelled with no cancelledBy: generic copy for both',
    'ride.cancelled',
    { rideId: RIDE, toStatus: 'CANCELLED' },
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: cancelRows(CUSTOMER_CANCELLED, DRIVER_CANCELLED),
      enqueues: [
        rideEnqueue(1, 'ride.cancelled', 1),
        rideEnqueue(2, 'ride.cancelled', 1, DRIVER_USER),
      ],
      created: 2,
    },
  ),
  scenario(
    'G18',
    'cancelled ride with no driver: customer only',
    'ride.cancelled',
    cancelData('customer', RIDE_NO_DRIVER),
    {
      rideLookups: [RIDE_NO_DRIVER, RIDE_NO_DRIVER],
      rows: [
        rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, CUSTOMER_CANCELLED, {
          rideId: RIDE_NO_DRIVER,
        }),
      ],
      enqueues: [
        enqueue(1, {
          userId: CUSTOMER_USER,
          type: 'ride.cancelled',
          category: 'TRANSACTIONAL',
          rideId: RIDE_NO_DRIVER,
          priority: 1,
        }),
      ],
      created: 1,
    },
  ),
  scenario(
    'G19',
    'cancelled ride whose driver has no record: customer only',
    'ride.cancelled',
    cancelData('customer', RIDE_GHOST_DRIVER),
    {
      rideLookups: [RIDE_GHOST_DRIVER, RIDE_GHOST_DRIVER],
      driverLookups: [GHOST_DRIVER],
      rows: [
        rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, CUSTOMER_CANCELLED, {
          rideId: RIDE_GHOST_DRIVER,
        }),
      ],
      enqueues: [
        enqueue(1, {
          userId: CUSTOMER_USER,
          type: 'ride.cancelled',
          category: 'TRANSACTIONAL',
          rideId: RIDE_GHOST_DRIVER,
          priority: 1,
        }),
      ],
      created: 1,
    },
  ),
  scenario(
    'G20',
    'cancelled: the customer-side ride lookup throws, the driver is still told',
    'ride.cancelled',
    cancelData('customer'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: [
        rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, DRIVER_CANCELLED_BY_CUSTOMER, {
          userId: DRIVER_USER,
        }),
      ],
      enqueues: [rideEnqueue(1, 'ride.cancelled', 1, DRIVER_USER)],
      created: 1,
    },
    { rideLookupFailsOnCall: [1] },
  ),
  scenario(
    'G21',
    'cancelled: the driver-side ride lookup throws, the customer is still told',
    'ride.cancelled',
    cancelData('customer'),
    {
      rideLookups: [RIDE, RIDE],
      rows: [rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, CUSTOMER_CANCELLED)],
      enqueues: [rideEnqueue(1, 'ride.cancelled', 1)],
      created: 1,
    },
    { rideLookupFailsOnCall: [2] },
  ),
  scenario(
    'G22',
    'cancelled: the driver lookup throws, the customer is still told',
    'ride.cancelled',
    cancelData('customer'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: [rideRow('ride.cancelled', 'HIGH', CANCEL_TITLE, CUSTOMER_CANCELLED)],
      enqueues: [rideEnqueue(1, 'ride.cancelled', 1)],
      created: 1,
    },
    { driverLookupFails: true },
  ),
  scenario(
    'G23',
    'cancelled: the customer insert throws, the driver is still told',
    'ride.cancelled',
    cancelData('customer'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: cancelRows(CUSTOMER_CANCELLED, DRIVER_CANCELLED_BY_CUSTOMER),
      enqueues: [rideEnqueue(2, 'ride.cancelled', 1, DRIVER_USER)],
      created: 1,
    },
    { createFailsForUser: CUSTOMER_USER },
  ),
  scenario(
    'G24',
    'cancelled: the driver insert throws, the customer is still told',
    'ride.cancelled',
    cancelData('customer'),
    {
      rideLookups: [RIDE, RIDE],
      driverLookups: [DRIVER],
      rows: cancelRows(CUSTOMER_CANCELLED, DRIVER_CANCELLED_BY_CUSTOMER),
      enqueues: [rideEnqueue(1, 'ride.cancelled', 1)],
      created: 1,
    },
    { createFailsForUser: DRIVER_USER },
  ),

  // ── ride.request.expired (customer from the payload, no lookup) ──
  scenario(
    'G25',
    'request expired notifies data.customerId with no ride lookup',
    'ride.request.expired',
    { requestId: REQUEST, customerId: CUSTOMER_USER },
    {
      rows: [
        row({
          userId: CUSTOMER_USER,
          type: 'ride.request.expired',
          priority: 'NORMAL',
          title: EXPIRED_TITLE,
          body: EXPIRED_BODY,
          data: payload('ride.request.expired', 'TRANSACTIONAL', { requestId: REQUEST }),
          rideId: null,
        }),
      ],
      enqueues: [
        enqueue(1, {
          userId: CUSTOMER_USER,
          type: 'ride.request.expired',
          category: 'TRANSACTIONAL',
          rideId: null,
          priority: 2,
        }),
      ],
      created: 1,
    },
  ),
  scenario(
    'G26',
    'request expired without customerId: nothing',
    'ride.request.expired',
    {
      requestId: REQUEST,
    },
    {},
  ),
  scenario(
    'G27',
    'erased user: user state is never consulted, so the row is still written',
    'ride.request.expired',
    { requestId: REQUEST, customerId: ERASED_USER },
    {
      rows: [
        row({
          userId: ERASED_USER,
          type: 'ride.request.expired',
          priority: 'NORMAL',
          title: EXPIRED_TITLE,
          body: EXPIRED_BODY,
          data: payload('ride.request.expired', 'TRANSACTIONAL', { requestId: REQUEST }),
          rideId: null,
        }),
      ],
      enqueues: [
        enqueue(1, {
          userId: ERASED_USER,
          type: 'ride.request.expired',
          category: 'TRANSACTIONAL',
          rideId: null,
          priority: 2,
        }),
      ],
      created: 1,
    },
  ),

  // ── Payments (customer) ──
  scenario(
    'G28',
    'collected with a numeric amount states it to two decimals',
    'payment.ride.collected',
    { rideId: RIDE, customerId: CUSTOMER_USER, driverId: DRIVER, amount: 150, method: 'CASH' },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'payment.ride.collected',
          'NORMAL',
          'Payment received',
          'Your fare of ₹150.00 has been paid. Thanks for riding.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'payment.ride.collected', 2)],
      created: 1,
    },
  ),
  scenario(
    'G29',
    'collected without an amount keeps the existing copy',
    'payment.ride.collected',
    { rideId: RIDE, customerId: CUSTOMER_USER, method: 'CASH' },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'payment.ride.collected',
          'NORMAL',
          'Payment received',
          'Your fare of has been paid. Thanks for riding.',
        ),
      ],
      enqueues: [rideEnqueue(1, 'payment.ride.collected', 2)],
      created: 1,
    },
  ),
  scenario(
    'G30',
    'collection failed with willRetry=false notifies the customer',
    'payment.ride.collection_failed',
    {
      rideId: RIDE,
      customerId: CUSTOMER_USER,
      amount: 150,
      attempt: 3,
      willRetry: false,
      reason: 'declined',
    },
    {
      rideLookups: [RIDE],
      rows: [
        rideRow(
          'payment.ride.collection_failed',
          'NORMAL',
          COLLECTION_FAILED_TITLE,
          COLLECTION_FAILED_BODY,
        ),
      ],
      enqueues: [rideEnqueue(1, 'payment.ride.collection_failed', 2)],
      created: 1,
    },
  ),
  scenario(
    'G31',
    'collection failed with willRetry=true: nothing, no lookup',
    'payment.ride.collection_failed',
    {
      rideId: RIDE,
      customerId: CUSTOMER_USER,
      amount: 150,
      attempt: 1,
      willRetry: true,
      reason: 'declined',
    },
    {},
  ),
  scenario(
    'G32',
    'collection failed with willRetry missing: nothing, no lookup',
    'payment.ride.collection_failed',
    { rideId: RIDE, customerId: CUSTOMER_USER, amount: 150 },
    {},
  ),
  scenario(
    'G33',
    'collection failed with willRetry="false" (a string): nothing, no lookup',
    'payment.ride.collection_failed',
    { rideId: RIDE, customerId: CUSTOMER_USER, amount: 150, willRetry: 'false' },
    {},
  ),

  // ── Missing / unknown ride, for every ride-resolved event ──
  ...RIDE_ID_EVENTS.map(({ type, data }) =>
    scenario(
      'G34',
      `${type} without rideId: nothing, no lookup`,
      type,
      withoutUndefined(data()),
      {},
    ),
  ),
  ...RIDE_ID_EVENTS.map(({ type, data }) =>
    scenario(
      'G35',
      `${type} for a ride that does not exist: nothing`,
      type,
      withoutUndefined(data(RIDE_MISSING)),
      {
        // ride.cancelled resolves the ride once per participant.
        rideLookups: type === 'ride.cancelled' ? [RIDE_MISSING, RIDE_MISSING] : [RIDE_MISSING],
      },
    ),
  ),

  // ── Failure isolation ──
  scenario(
    'G36',
    'ride lookup throws: nothing, and the handler resolves',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER },
    { rideLookups: [RIDE] },
    { rideLookupFailsOnCall: [1] },
  ),
  scenario(
    'G37',
    'duplicate insert: no enqueue, not counted as created',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER },
    { rideLookups: [RIDE], rows: [startedRow] },
    { createReturnsDuplicate: true },
  ),
  scenario(
    'G38',
    'enqueue rejects: the row stays, the failure is counted, the handler resolves',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER },
    {
      rideLookups: [RIDE],
      rows: [startedRow],
      enqueues: [rideEnqueue(1, 'ride.started', 2)],
      created: 1,
      enqueueFailed: 1,
    },
    { enqueueRejects: true },
  ),
  scenario(
    'G39',
    'insert throws: no enqueue, nothing counted, the handler resolves',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER },
    { rideLookups: [RIDE], rows: [startedRow] },
    { createFailsForUser: CUSTOMER_USER },
  ),

  // ── Payload shape ──
  scenario(
    'G40',
    'a non-offer event passes string ids through but never expiresAt',
    'ride.started',
    { rideId: RIDE, driverId: DRIVER, requestId: REQUEST, dispatchId: DISPATCH, expiresAt: FUTURE },
    {
      rideLookups: [RIDE],
      rows: [
        row({
          userId: CUSTOMER_USER,
          type: 'ride.started',
          priority: 'NORMAL',
          title: 'Trip started',
          body: 'Your trip is now in progress.',
          data: payload('ride.started', 'TRANSACTIONAL', {
            rideId: RIDE,
            requestId: REQUEST,
            dispatchId: DISPATCH,
          }),
          rideId: RIDE,
        }),
      ],
      enqueues: [rideEnqueue(1, 'ride.started', 2)],
      created: 1,
    },
  ),
];

// ── Planner outcomes (S3) ────────────────────────────────────────────────────
//
// What `planNotifications` decides for each scenario above: one outcome per
// participant, in the order the consumer handles them. A second column rather
// than an edit to the rows, so the consumer-pinned expectations stay exactly as
// S1 verified them. Every `notify` here must line up, in order, with the rows
// the consumer inserted; the planner test checks that too.

export type GoldenAudience = 'customer' | 'driver';

export type GoldenOutcome =
  | { kind: 'notify'; audience: GoldenAudience; deliveryClass: string; bullMqPriority: number }
  | { kind: 'skip'; audience: GoldenAudience; reason: string }
  | { kind: 'lookup_failed'; audience: GoldenAudience };

const notifyCustomer = (bullMqPriority: number): GoldenOutcome => ({
  kind: 'notify',
  audience: 'customer',
  deliveryClass: 'TRANSACTIONAL',
  bullMqPriority,
});
const DRIVER_OFFER: GoldenOutcome = {
  kind: 'notify',
  audience: 'driver',
  deliveryClass: 'RIDE_OFFER',
  bullMqPriority: 1,
};
const DRIVER_CANCEL: GoldenOutcome = {
  kind: 'notify',
  audience: 'driver',
  deliveryClass: 'TRANSACTIONAL',
  bullMqPriority: 1,
};
const skipCustomer = (reason: string): GoldenOutcome => ({
  kind: 'skip',
  audience: 'customer',
  reason,
});
const skipDriver = (reason: string): GoldenOutcome => ({
  kind: 'skip',
  audience: 'driver',
  reason,
});
const CUSTOMER_LOOKUP_FAILED: GoldenOutcome = { kind: 'lookup_failed', audience: 'customer' };
const DRIVER_LOOKUP_FAILED: GoldenOutcome = { kind: 'lookup_failed', audience: 'driver' };
const CANCEL_BOTH = [notifyCustomer(1), DRIVER_CANCEL];

/// Keyed by scenario id. G34 and G35 are one id each over eight event types,
/// so they are decided by type in `expectedOutcomes`.
export const OUTCOMES_BY_ID: Readonly<Record<string, GoldenOutcome[]>> = {
  G01: [DRIVER_OFFER],
  G02: [DRIVER_OFFER], // the planner reads no clock; the expired window is the writer's call
  G03: [DRIVER_OFFER],
  G04: [skipDriver('missing_driver_id')],
  G05: [skipDriver('driver_not_found')],
  G06: [DRIVER_LOOKUP_FAILED],
  G07: [notifyCustomer(1)],
  G08: [notifyCustomer(2)],
  G09: [notifyCustomer(1)],
  G10: [notifyCustomer(2)],
  G11: [notifyCustomer(2)],
  G12: [notifyCustomer(2)],
  G13: [notifyCustomer(2)],
  G14: CANCEL_BOTH,
  G15: CANCEL_BOTH,
  G16: CANCEL_BOTH,
  G17: CANCEL_BOTH,
  G18: [notifyCustomer(1), skipDriver('ride_has_no_driver')],
  G19: [notifyCustomer(1), skipDriver('driver_not_found')],
  G20: [CUSTOMER_LOOKUP_FAILED, DRIVER_CANCEL],
  G21: [notifyCustomer(1), DRIVER_LOOKUP_FAILED],
  G22: [notifyCustomer(1), DRIVER_LOOKUP_FAILED],
  G23: CANCEL_BOTH, // insert failures belong to the writer, not the plan
  G24: CANCEL_BOTH,
  G25: [notifyCustomer(2)],
  G26: [skipCustomer('missing_customer_id')],
  G27: [notifyCustomer(2)],
  G28: [notifyCustomer(2)],
  G29: [notifyCustomer(2)],
  G30: [notifyCustomer(2)],
  G31: [skipCustomer('will_retry')],
  G32: [skipCustomer('will_retry')],
  G33: [skipCustomer('will_retry')],
  G36: [CUSTOMER_LOOKUP_FAILED],
  G37: [notifyCustomer(2)], // duplicate / enqueue / insert faults are writer-side
  G38: [notifyCustomer(2)],
  G39: [notifyCustomer(2)],
  G40: [notifyCustomer(2)],
};

export function expectedOutcomes(scenario: GoldenScenario): GoldenOutcome[] {
  if (scenario.id === 'G34' || scenario.id === 'G35') {
    const reason = scenario.id === 'G34' ? 'missing_ride_id' : 'ride_not_found';
    return scenario.type === 'ride.cancelled'
      ? [skipCustomer(reason), skipDriver(reason)]
      : [skipCustomer(reason)];
  }
  const outcomes = OUTCOMES_BY_ID[scenario.id];
  if (!outcomes) throw new Error(`no planner outcome recorded for ${scenario.id}`);
  return outcomes;
}
