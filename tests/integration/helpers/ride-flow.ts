import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { paymentConfig } from '../../../src/config/payment/payment.config.js';

import { db, drainOutbox, loginAs, type LoggedInUser } from './harness.js';
import {
  completeProfile,
  grantRole,
  makeActiveSubscription,
  makeAssignedVehicle,
  makeDispatchOffer,
  makeDriver,
  makeVehicleType,
  markDriverOnline,
  setRidePin,
  RIDE_PIN,
} from './fixtures.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import { MockGatewayProvider } from '../../../src/modules/payments/services/gateway/mock.gateway.js';
import type {
  CreateGatewayIntentInput,
  GatewayIntentResult,
  OrderPayments,
} from '../../../src/modules/payments/services/gateway/gateway.provider.js';

/// Makes the gateway decline every confirmation until the returned restore
/// function is called. Every gateway caller (`IntentService`, `PayoutService`)
/// resolves a FRESH provider instance per call via
/// `PaymentGatewayResolverService`, not a cached DI singleton, so patching
/// one resolved instance would not affect the next call — this patches the
/// prototype method instead, which every `MockGatewayProvider` instance
/// shares regardless of when it was constructed.
export function declineGateway(): () => void {
  const original = MockGatewayProvider.prototype.confirmIntent;
  const originalLookup = MockGatewayProvider.prototype.fetchOrderPayments;
  MockGatewayProvider.prototype.confirmIntent = async function (
    gatewayIntentId: string,
  ): Promise<GatewayIntentResult> {
    return { gatewayIntentId, status: 'FAILED' };
  };
  // IntentService reads provider truth here since 005 T024.
  MockGatewayProvider.prototype.fetchOrderPayments = async function (
    orderId: string,
  ): Promise<OrderPayments> {
    const payment = {
      id: `mock_pay_declined_${orderId}`,
      orderId,
      amountPaise: 0,
      currency: 'INR',
      status: 'failed' as const,
      method: 'mock',
      createdAt: null,
    };
    return { kind: 'failed', payment, additionalCaptures: [] };
  };
  return () => {
    MockGatewayProvider.prototype.confirmIntent = original;
    MockGatewayProvider.prototype.fetchOrderPayments = originalLookup;
  };
}

/// What Razorpay reports for a capture of one of our intents in full: its real
/// order id and the amount in paise. `reference` may be the order id or the
/// intent's own id. The validation gate (005 T024) checks both fields, so a
/// payload without them, or carrying the intent id as the order, applies
/// nothing.
export async function capturedPaymentFields(
  reference: string,
): Promise<{ order_id: string; amount: number; currency: string }> {
  const intent = await db().client.paymentIntent.findFirst({
    where: /^[0-9a-f-]{36}$/i.test(reference)
      ? { OR: [{ gatewayIntentId: reference }, { id: reference }] }
      : { gatewayIntentId: reference },
  });
  if (!intent) return { order_id: reference, amount: 0, currency: 'INR' };
  return {
    order_id: intent.gatewayIntentId ?? reference,
    amount: intent.amount.mul(100).toNumber(),
    currency: intent.currency,
  };
}

/// Records every `createIntent` input the mock gateway receives, so a test
/// can assert on whether — and with what — a gateway was actually called.
/// Same prototype-patch reasoning as `declineGateway`: a fresh provider is
/// resolved per call, so there is no cached instance to spy on directly.
export function captureGatewayIntentInputs(): {
  calls: CreateGatewayIntentInput[];
  restore: () => void;
} {
  const calls: CreateGatewayIntentInput[] = [];
  const original = MockGatewayProvider.prototype.createIntent;
  MockGatewayProvider.prototype.createIntent = async function (
    input: CreateGatewayIntentInput,
  ): Promise<GatewayIntentResult> {
    calls.push(input);
    return original.call(this, input);
  };
  return {
    calls,
    restore: () => {
      MockGatewayProvider.prototype.createIntent = original;
    },
  };
}

export interface RideWorld {
  customer: LoggedInUser;
  driver: LoggedInUser;
  driverId: string;
  vehicleId: string;
  vehicleTypeId: string;
}

export interface FareRow {
  totalFare: Decimal;
  driverEarning: Decimal;
  platformCommission: Decimal;
  /// FR-006. Tax and the platform fee are destinations of their own now, so a
  /// test reconciling a ledger group has to be able to name them.
  taxAmount: Decimal;
  platformFee: Decimal;
}

/// A rider, a verified online driver with an assigned vehicle, and a vehicle
/// type — everything `POST /rides/requests` through `/complete` needs.
///
/// Five separate gates make a ride refuse to book or accept, and each one hid
/// the next when this was first written: a rider with no profile name is 422
/// INCOMPLETE_PROFILE, a rider with no Ride PIN is 422
/// RIDE_PIN_NOT_CONFIGURED, acceptance without a dispatch offer is 404
/// RIDE_OFFER_NOT_FOUND, an offline driver is 409 DRIVER_NOT_AVAILABLE, and a
/// driver with no active assignment is 409 VEHICLE_MISMATCH.
export async function rideWorld(
  app: FastifyInstance,
  phones: { customer: string; driver: string },
  options: {
    /// 004-driver-subscription-wallet. Omit entirely for the safe default —
    /// SUBSCRIPTION, with an active subscription already in place — since
    /// this helper is shared by every ride-lifecycle/payments/settlement
    /// suite in the integration tree and SUBSCRIPTION is the one model with
    /// *zero* Commission Wallet or ledger activity of its own (FR-006b/
    /// FR-024c), so it cannot interact with any of those suites' existing,
    /// financially-exact assertions. Pass `paymentModel` explicitly only for
    /// a test that is actually about payment-model/commission-wallet
    /// behaviour — those tests fund/inspect the wallet themselves.
    driver?: {
      paymentModel?: 'COMMISSION' | 'SUBSCRIPTION' | null;
      commissionWalletBalance?: number;
    };
  } = {},
): Promise<RideWorld> {
  const initialCustomer = await loginAs(app, phones.customer);
  await completeProfile(initialCustomer.userId);
  // Fifth gate: booking now refuses a rider with no Ride PIN (422
  // RIDE_PIN_NOT_CONFIGURED), because that rider could never start the ride they
  // are about to book.
  await setRidePin(initialCustomer.userId);
  const initialDriver = await loginAs(app, phones.driver);
  await grantRole(initialDriver.userId, 'driver');
  const explicitPaymentModel = options.driver?.paymentModel !== undefined;
  const driverId = await makeDriver(initialDriver.userId, {
    verified: true,
    ...(explicitPaymentModel ? options.driver : { paymentModel: 'SUBSCRIPTION' }),
  });
  if (!explicitPaymentModel) {
    await makeActiveSubscription(driverId);
  }
  const vehicleTypeId = await makeVehicleType();
  const { vehicleId } = await makeAssignedVehicle(driverId, { vehicleTypeId, verified: true });
  await markDriverOnline(driverId);

  // Setup publishes events — a granted role, a verified driver — and with the
  // real consumers subscribed those bump the user's token epoch the moment the
  // outbox drains, staling every token issued before. Draining here and
  // logging in afterwards means these tokens survive every later drain.
  await drainOutbox();
  const customer = await loginAs(app, phones.customer);
  const driver = await loginAs(app, phones.driver);

  return { customer, driver, driverId, vehicleId, vehicleTypeId };
}

/// Books a ride request over real HTTP — the quote/estimate-producing half of
/// `completeRide`, split out so a caller that needs to inspect state
/// (e.g. `Ride.commissionAmount`) between acceptance and completion can do so.
export async function bookRideRequest(
  app: FastifyInstance,
  world: RideWorld,
  options: { distanceKm: number; paymentMethod?: string },
): Promise<string> {
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/requests',
    headers: world.customer.authHeader,
    payload: {
      vehicleTypeId: world.vehicleTypeId,
      pickupLat: 12.9716,
      pickupLng: 77.5946,
      // ~0.009 deg of latitude is ~1 km, so the quoted route scales with the
      // distance this ride will report. Quoting one fixed short route and then
      // completing 40 km is refused by assertPlausibleTripData.
      dropLat: 12.9716 + options.distanceKm * 0.009,
      dropLng: 77.5946,
      paymentMethod: options.paymentMethod ?? 'CARD',
    },
  });
  assert.equal(requested.statusCode, 200, requested.payload);
  return requested.json().data.id;
}

/// Offers and accepts one already-booked request over real HTTP, returning
/// the ride's id. This is the exact moment `Ride.driverPaymentModel` /
/// `Ride.commissionAmount` are determined and stored (spec.md FR-013b).
export async function acceptRide(
  app: FastifyInstance,
  world: RideWorld,
  requestId: string,
): Promise<string> {
  await makeDispatchOffer(requestId, world.driverId);

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/v1/rides/accept',
    headers: world.driver.authHeader,
    payload: { requestId, vehicleId: world.vehicleId },
  });
  assert.equal(accepted.statusCode, 200, accepted.payload);

  return accepted.json().data.ride.id;
}

/// Puts the driver's last fix at a point, as if they had driven there. Arrive
/// and complete enforce the pickup/drop geofences against `driver_locations`;
/// posting the move through /drivers/location would (rightly) be refused as an
/// implausible jump, since the test does not wait out the trip's real duration.
export async function placeDriverAt(driverId: string, lat: unknown, lng: unknown): Promise<void> {
  await db().client.$executeRaw`
    INSERT INTO driver_locations (driver_id, latitude, longitude, location, recorded_at)
    VALUES (${driverId}::uuid, ${lat}::numeric, ${lng}::numeric,
            ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography, now())
    ON CONFLICT (driver_id) DO UPDATE
      SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          location = EXCLUDED.location, recorded_at = EXCLUDED.recorded_at`;
}

/// Arrives, starts and completes an already-accepted ride over real HTTP,
/// returning the fare the server priced it at.
export async function finishRide(
  app: FastifyInstance,
  world: RideWorld,
  rideId: string,
  options: { distanceKm: number; durationMin: number },
): Promise<FareRow> {
  const [route] = await db().client.$queryRaw<
    { pickupLat: unknown; pickupLng: unknown; dropLat: unknown; dropLng: unknown }[]
  >`SELECT rr.pickup_lat AS "pickupLat", rr.pickup_lng AS "pickupLng",
           rr.drop_lat AS "dropLat", rr.drop_lng AS "dropLng"
      FROM rides r JOIN ride_requests rr ON rr.id = r.request_id
     WHERE r.id = ${rideId}::uuid`;
  assert.ok(route, `ride ${rideId} has no request`);

  await placeDriverAt(world.driverId, route.pickupLat, route.pickupLng);
  const arrived = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/arrive`,
    headers: world.driver.authHeader,
    payload: {},
  });
  assert.equal(arrived.statusCode, 200, arrived.payload);

  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/start`,
    headers: world.driver.authHeader,
    payload: { pin: RIDE_PIN },
  });
  assert.equal(started.statusCode, 200, started.payload);

  if (route.dropLat != null && route.dropLng != null) {
    await placeDriverAt(world.driverId, route.dropLat, route.dropLng);
  }
  const completed = await app.inject({
    method: 'POST',
    url: `/api/v1/rides/${rideId}/complete`,
    headers: world.driver.authHeader,
    payload: { actualDistanceKm: options.distanceKm, actualDurationMin: options.durationMin },
  });
  assert.equal(completed.statusCode, 200, completed.payload);

  const fare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
  return fare as unknown as FareRow;
}

/// Books, accepts, starts and completes one ride over real HTTP, returning the
/// fare the server priced it at.
///
/// D1: a new ride can no longer be booked as WALLET, so `paymentMethod:
/// 'WALLET'` here produces what such a ride now IS — a **historical** one: it
/// is booked and accepted with a permitted method, then the stored
/// `rides.payment_method` is set to WALLET directly, exactly as a row created
/// before the rule looks. Completion, collection, receivables and write-off
/// then run their real wallet paths against it, which is what the suites using
/// this option are testing.
export async function completeRide(
  app: FastifyInstance,
  world: RideWorld,
  options: { distanceKm: number; durationMin: number; paymentMethod?: string },
): Promise<{ rideId: string; fare: FareRow }> {
  const historicalWallet = options.paymentMethod === 'WALLET';
  const requestId = await bookRideRequest(
    app,
    world,
    historicalWallet ? { ...options, paymentMethod: 'CARD' } : options,
  );
  const rideId = await acceptRide(app, world, requestId);
  if (historicalWallet) {
    await db().client
      .$executeRaw`ALTER TABLE "rides" DISABLE TRIGGER "trg_check_no_new_wallet_ride"`;
    await db().client
      .$executeRaw`UPDATE "rides" SET "payment_method" = 'WALLET'::"PaymentMethod" WHERE "id" = ${rideId}::uuid`;
    await db().client
      .$executeRaw`ALTER TABLE "rides" ENABLE TRIGGER "trg_check_no_new_wallet_ride"`;
  }
  const fare = await finishRide(app, world, rideId, options);
  return { rideId, fare };
}

/// Net position of a ledger account: credits less debits.
export async function accountBalance(
  account: string,
  scope: { accountRefId?: string; rideId?: string } = {},
): Promise<Decimal> {
  const entries = await db().client.paymentLedgerEntry.findMany({
    where: {
      account,
      ...(scope.accountRefId ? { accountRefId: scope.accountRefId } : {}),
      ...(scope.rideId ? { referenceType: 'RIDE', referenceId: scope.rideId } : {}),
    },
  });
  return entries.reduce(
    (sum, e) => (e.direction === 'CREDIT' ? sum.add(e.amount) : sum.sub(e.amount)),
    new Decimal(0),
  );
}

/// Puts real, ledger-backed money in a rider's wallet.
///
/// Deliberately not a direct `customer_wallets` update: a balance that no
/// payment produced is exactly the defect US1 closed, and seeding one would
/// leave the wallet position disagreeing with the ledger in every assertion
/// made afterwards.
///
/// New customer top-ups can no longer be created (`GATEWAY_PAYMENT_PURPOSES`),
/// so this seeds the one kind that still exists — a historical, still-PENDING
/// `CUSTOMER_WALLET_TOPUP` intent row — and captures it through the real,
/// signed webhook, which credits the wallet and the ledger together.
export async function fundWallet(
  app: FastifyInstance,
  user: LoggedInUser,
  amount: number,
): Promise<void> {
  const intent = await db().client.paymentIntent.create({
    data: {
      userId: user.userId,
      amount,
      currency: 'INR',
      methodType: 'CARD',
      idempotencyKey: `legacy_topup_${randomUUID()}`,
      status: 'PENDING',
      gateway: 'mock',
      gatewayIntentId: `mock_pi_${randomUUID()}`,
      purpose: 'CUSTOMER_WALLET_TOPUP',
    },
  });

  // Real Razorpay webhook envelope — `event` at the top, the payment nested
  // under `payload.payment.entity`, `order_id` (the intent's own
  // `gatewayIntentId`, not its internal id) as the order reference. The
  // event id itself arrives only in the `X-Razorpay-Event-Id` header on a
  // real delivery.
  const body = JSON.stringify({
    event: 'payment.captured',
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
          order_id: intent.gatewayIntentId,
          amount: amount * 100,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  });
  const delivered = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac(
        'sha256',
        paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
      )
        .update(body)
        .digest('hex'),
      'x-razorpay-event-id': `evt_${randomUUID()}`,
    },
    payload: body,
  });
  assert.equal(delivered.statusCode, 200, delivered.payload);
}

/// Puts a delivered outbox row back on the queue, the way a relay that died
/// after handing an envelope to the bus but before marking it published
/// would.
export async function replayOutboxEvent(eventType: string): Promise<void> {
  await db().client.outboxEvent.updateMany({
    where: { eventType },
    data: { status: 'PENDING', claimedAt: null, nextAttemptAt: new Date() },
  });
}
