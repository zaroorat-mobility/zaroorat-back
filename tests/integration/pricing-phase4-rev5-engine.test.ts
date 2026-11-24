import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCityWithBoundary, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { acceptRide, finishRide, rideWorld } from './helpers/ride-flow.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import {
  NON_RECOVERY_GST_MODE_SETTING_KEY,
  REV5_PRICING_FLAGS,
} from '../../src/modules/pricing/index.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { CommissionWalletService } from '../../src/modules/payments/services/commission-wallet/commission-wallet.service.js';
import type { SettlementFailureRecoveryService } from '../../src/modules/payments/services/commission-wallet/settlement-failure-recovery.service.js';
import type { LedgerService } from '../../src/modules/payments/services/ledger/ledger.service.js';
import { LEDGER_ACCOUNTS } from '../../src/modules/payments/constants/payment.constants.js';

const MAKER_PHONE = '+919876649001';
const MAKER_EMAIL = 'phase4-maker@zaroorat.test';
const CHECKER_PHONE = '+919876649002';
const CHECKER_EMAIL = 'phase4-checker@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876649003';
const DRIVER_PHONE = '+919876649004';

const SGR_BOUNDS: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

describe('Phase 4 — Rev 5 Central Commission, GST, Recovery, Reservations & Failure Recovery (T1–T7)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    await resetRev5FlagsOff();
  });
  afterEach(async () => {
    await resetRev5FlagsOff();
    await resetState();
  });

  async function resetRev5FlagsOff() {
    for (const key of Object.values(REV5_PRICING_FLAGS)) {
      await db().client.featureFlag.upsert({
        where: { key },
        update: { status: 'OFF', isActive: true, rolloutPercentage: 100 },
        create: {
          key,
          name: key,
          description: key,
          status: 'OFF',
          isActive: true,
          rolloutPercentage: 100,
        },
      });
    }
    await db().client.systemSetting.deleteMany({
      where: {
        key: { in: [NON_RECOVERY_GST_MODE_SETTING_KEY, 'pricing.non_recovery_gst_contra_account'] },
      },
    });
  }

  async function loginAdmin(phone: string, email: string) {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return {
      userId: seed.userId,
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    };
  }

  async function setupSgrJurisdiction(makerHeaders: Record<string, string>) {
    await ensureCityWithBoundary('SGR', 'Srinagar', SGR_BOUNDS);
    await ensureServiceZone('SGR', 'SGR_CITY', 'Srinagar City', SGR_BOUNDS);
    await db().client.city.update({
      where: { code: 'SGR' },
      data: { stateCode: '01', stateName: 'Jammu and Kashmir' },
    });

    const entRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/legal-entities',
      headers: makerHeaders,
      payload: {
        legalEntityName: 'Zaroorat Mobility Private Limited',
        tradeName: 'Zaroorat',
        pan: 'AAACZ1234A',
        headOfficeAddress: 'Residency Road, Srinagar, J&K 190001',
      },
    });
    assert.equal(entRes.statusCode, 201, entRes.payload);
    const entityId = entRes.json().data.id as string;

    const regRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/legal-entities/${entityId}/gst-registrations`,
      headers: makerHeaders,
      payload: {
        gstin: '01AAACZ1234A1Z5',
        stateCode: '01',
        stateName: 'Jammu and Kashmir',
        registrationAddress: 'Residency Road, Srinagar, J&K 190001',
      },
    });
    assert.equal(regRes.statusCode, 201, regRes.payload);
    const gstRegistrationId = regRes.json().data.id as string;

    const mapRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/city-supply-registrations',
      headers: makerHeaders,
      payload: {
        cityCode: 'SGR',
        supplyKind: 'PASSENGER_RIDE',
        legalEntityId: entityId,
        gstRegistrationId,
      },
    });
    assert.equal(mapRes.statusCode, 201, mapRes.payload);
    return { entityId, gstRegistrationId };
  }

  async function seedActiveGlobalConfigs(
    makerHeaders: Record<string, string>,
    checkerHeaders: Record<string, string>,
  ) {
    // 1. Commission 7% (GLOBAL) — no GSTIN required!
    const cCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commission-configurations',
      headers: makerHeaders,
      payload: {
        commissionRatePct: 7,
        isEnabled: true,
        applyTo: 'NEW_RIDES_ONLY',
        scopes: [{}],
      },
    });
    assert.equal(cCreate.statusCode, 201, cCreate.payload);
    const cApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-configurations/${cCreate.json().data.id}/approve`,
      headers: checkerHeaders,
    });
    assert.equal(cApprove.statusCode, 200, cApprove.payload);

    // 2. Passenger GST 5% (GLOBAL) with CA-approved SAC, waitingTaxable & legalReference
    const tCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tax-configurations',
      headers: makerHeaders,
      payload: {
        kind: 'PASSENGER_RIDE_GST',
        ratePct: 5,
        isEnabled: true,
        inclusive: false,
        waitingTaxable: false,
        sacCode: '996412',
        legalReference: 'CA-OPINION-2026-01',
        applyTo: 'NEW_RIDES_ONLY',
        scopes: [{}],
      },
    });
    assert.equal(tCreate.statusCode, 201, tCreate.payload);
    const tApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tax-configurations/${tCreate.json().data.id}/approve`,
      headers: checkerHeaders,
    });
    assert.equal(tApprove.statusCode, 200, tApprove.payload);

    // 3. Independent GST Recovery 5% (GLOBAL)
    const rCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/gst-recovery-configurations',
      headers: makerHeaders,
      payload: {
        recoveryRatePct: 5,
        isEnabled: true,
        baseRule: 'PASSENGER_GST_AMOUNT',
        applyTo: 'NEW_RIDES_ONLY',
        scopes: [{}],
      },
    });
    assert.equal(rCreate.statusCode, 201, rCreate.payload);
    const rApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/gst-recovery-configurations/${rCreate.json().data.id}/approve`,
      headers: checkerHeaders,
    });
    assert.equal(rApprove.statusCode, 200, rApprove.payload);

    return {
      commissionConfigId: cCreate.json().data.id as string,
      taxConfigId: tCreate.json().data.id as string,
      recoveryConfigId: rCreate.json().data.id as string,
    };
  }

  async function fundCommissionWalletWithLedger(driverId: string, amount: number) {
    // Reset any un-ledgered test-fixture balance seeded by `makeDriver` so Invariant 1 (Wallet <-> Ledger) starts cleanly at 0.
    await db().client.driverCommissionWallet.updateMany({
      where: { driverId },
      data: { balance: new Decimal(0) },
    });
    const walletSvc = container.resolve<CommissionWalletService>('commissionWalletService');
    const ledgerSvc = container.resolve<LedgerService>('ledgerService');
    const dec = new Decimal(amount);
    await db().transactionManager.execute(async (tx) => {
      await walletSvc.creditInTx(driverId, dec, tx, {
        referenceType: 'RECHARGE',
        description: 'Phase 4 test funding',
      });
      await ledgerSvc.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.GATEWAY_CLEARING,
            direction: 'DEBIT',
            amount: dec,
            referenceType: 'RECHARGE',
            description: 'Phase 4 test recharge clearing',
          },
          {
            account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
            accountRefId: driverId,
            direction: 'CREDIT',
            amount: dec,
            referenceType: 'RECHARGE',
            description: 'Phase 4 test wallet credit',
          },
        ],
        tx,
      );
    });
  }

  it('T3 — Per-scope multi-scope activation preserves sibling scopes, enforces maker-checker & NEW_RIDES_ONLY', async () => {
    const maker = await loginAdmin(MAKER_PHONE, MAKER_EMAIL);
    const checker = await loginAdmin(CHECKER_PHONE, CHECKER_EMAIL);
    const vehicleType = await db().client.vehicleType.findFirstOrThrow();

    // ALL_ONGOING_AND_NEW is strictly rejected (400)
    const badApplyTo = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commission-configurations',
      headers: maker.headers,
      payload: {
        commissionRatePct: 7,
        applyTo: 'ALL_ONGOING_AND_NEW',
        scopes: [{}],
      },
    });
    assert.equal(badApplyTo.statusCode, 400, badApplyTo.payload);

    // Parent A covers ['SGR', 'BAR'] x vehicleType
    const parentARes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commission-configurations',
      headers: maker.headers,
      payload: {
        commissionRatePct: 7,
        declaredEffectiveFrom: new Date(Date.now() - 60_000).toISOString(),
        scopes: [
          { cityCode: 'SGR', vehicleTypeId: vehicleType.id },
          { cityCode: 'BAR', vehicleTypeId: vehicleType.id },
        ],
      },
    });
    assert.equal(parentARes.statusCode, 201, parentARes.payload);
    const parentAId = parentARes.json().data.id as string;

    // Self-approval blocked by maker-checker (403 MAKER_CHECKER_VIOLATION)
    const selfApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-configurations/${parentAId}/approve`,
      headers: maker.headers,
    });
    assert.equal(selfApprove.statusCode, 403, selfApprove.payload);
    assert.equal(selfApprove.json().error.code, 'MAKER_CHECKER_VIOLATION');

    // Checker approves Parent A -> ACTIVE
    const approveA = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-configurations/${parentAId}/approve`,
      headers: checker.headers,
    });
    assert.equal(approveA.statusCode, 200, approveA.payload);
    assert.equal(approveA.json().data.status, 'ACTIVE');

    // Parent B overrides ONLY 'SGR' x vehicleType from a future date
    const futureFrom = new Date(Date.now() + 3_600_000).toISOString();
    const parentBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commission-configurations',
      headers: maker.headers,
      payload: {
        commissionRatePct: 8.5,
        declaredEffectiveFrom: futureFrom,
        scopes: [{ cityCode: 'SGR', vehicleTypeId: vehicleType.id }],
      },
    });
    assert.equal(parentBRes.statusCode, 201, parentBRes.payload);
    const approveB = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-configurations/${parentBRes.json().data.id}/approve`,
      headers: checker.headers,
    });
    assert.equal(approveB.statusCode, 200, approveB.payload);
    assert.equal(approveB.json().data.status, 'SCHEDULED');

    // Verify Parent A became PARTIALLY_SUPERSEDED, 'SGR' scope closed at futureFrom, 'BAR' sibling scope STILL OPEN!
    const parentAAfter = await db().client.commissionConfiguration.findUniqueOrThrow({
      where: { id: parentAId },
      include: { scopes: true },
    });
    assert.equal(parentAAfter.status, 'PARTIALLY_SUPERSEDED');
    const sgrScope = parentAAfter.scopes.find((s) => s.cityCode === 'SGR');
    const barScope = parentAAfter.scopes.find((s) => s.cityCode === 'BAR');
    assert.equal(sgrScope?.effectiveTo?.toISOString(), futureFrom);
    assert.equal(barScope?.isEnforced, true);
    assert.equal(barScope?.effectiveTo, null);

    // Overlapping Parent C on 'SGR' x vehicleType starting before futureFrom -> 409 CONFIG_SCOPE_OVERLAP
    const parentCRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commission-configurations',
      headers: maker.headers,
      payload: {
        commissionRatePct: 9,
        declaredEffectiveFrom: new Date(Date.now() + 1_800_000).toISOString(),
        scopes: [{ cityCode: 'SGR', vehicleTypeId: vehicleType.id }],
      },
    });
    assert.equal(parentCRes.statusCode, 201, parentCRes.payload);
    const overlapApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-configurations/${parentCRes.json().data.id}/approve`,
      headers: checker.headers,
    });
    assert.equal(overlapApprove.statusCode, 409, overlapApprove.payload);
    assert.equal(overlapApprove.json().error.code, 'CONFIG_SCOPE_OVERLAP');
  });

  it('T1 — Path A grandfathered subscription driver bypasses wallet/GST and records 3 SKIPPED_GRANDFATHERED_SUBSCRIPTION steps', async () => {
    const maker = await loginAdmin(MAKER_PHONE, MAKER_EMAIL);
    const checker = await loginAdmin(CHECKER_PHONE, CHECKER_EMAIL);
    await setupSgrJurisdiction(maker.headers);
    await seedActiveGlobalConfigs(maker.headers, checker.headers);

    // Enable Mode A flags cleanly via FeatureFlagDependencyValidator!
    const flagRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/feature-flags',
      headers: checker.headers,
      payload: {
        flags: [
          { key: REV5_PRICING_FLAGS.SNAPSHOT_READ, status: 'ON' },
          { key: REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE, status: 'ON' },
          { key: REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED, status: 'ON' },
          { key: REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION, status: 'ON' },
          { key: REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED, status: 'ON' },
          { key: REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED, status: 'ON' },
        ],
      },
    });
    assert.equal(flagRes.statusCode, 200, flagRes.payload);

    // Default rideWorld creates a grandfathered active SUBSCRIPTION driver with ₹0 commission wallet
    const w = await rideWorld(app, { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE });

    // Commission terms API reports grandfathered subscription cleanly
    const termsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me/commission-terms',
      headers: w.driver.authHeader,
    });
    assert.equal(termsRes.statusCode, 200, termsRes.payload);
    assert.equal(termsRes.json().data.paymentModel, 'SUBSCRIPTION');
    assert.equal(termsRes.json().data.grandfathered, true);
    assert.equal(termsRes.json().data.autoRenew, false);

    // Selecting SUBSCRIPTION is blocked when drivers.subscription_model_enabled = OFF
    const subBlocked = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/payment-model',
      headers: w.driver.authHeader,
      payload: { model: 'SUBSCRIPTION' },
    });
    assert.equal(subBlocked.statusCode, 403, subBlocked.payload);
    assert.equal(subBlocked.json().error.code, 'SUBSCRIPTION_MODEL_DISABLED');

    // Book, accept & complete ride in SGR with ₹0 commission wallet
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 34.0837,
        pickupLng: 74.7973,
        dropLat: 34.12,
        dropLng: 74.83,
        paymentMethod: 'CASH',
      },
    });
    assert.equal(reqRes.statusCode, 200, reqRes.payload);
    const rideId = await acceptRide(app, w, reqRes.json().data.id);

    const acceptedRide = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    assert.ok(acceptedRide.driverSubscriptionId);
    assert.equal(acceptedRide.commissionSnapshot, null);
    assert.equal(acceptedRide.passengerGstSnapshot, null);
    assert.equal(acceptedRide.gstRecoverySnapshot, null);

    await finishRide(app, w, rideId, { distanceKm: 5, durationMin: 12 });

    const steps = await db().client.rideSettlementStep.findMany({ where: { rideId } });
    assert.equal(steps.length, 3);
    assert.ok(steps.every((s) => s.status === 'SKIPPED_GRANDFATHERED_SUBSCRIPTION'));

    const walletTxns = await db().client.driverCommissionWalletTransaction.count({
      where: { rideId },
    });
    assert.equal(walletTxns, 0);

    const taxCredits = await db().client.paymentLedgerEntry.count({
      where: { referenceId: rideId, account: LEDGER_ACCOUNTS.TAX_PAYABLE },
    });
    assert.equal(taxCredits, 0);
  });

  it('T2 — Mode B defaults to driver-liable informational GST and isolates the clearing account', async () => {
    const maker = await loginAdmin(MAKER_PHONE, MAKER_EMAIL);
    const checker = await loginAdmin(CHECKER_PHONE, CHECKER_EMAIL);
    await setupSgrJurisdiction(maker.headers);
    await seedActiveGlobalConfigs(maker.headers, checker.headers);

    // Turn on snapshot_read first
    const snapOn = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.SNAPSHOT_READ}`,
      headers: checker.headers,
      payload: { status: 'ON' },
    });
    assert.equal(snapOn.statusCode, 200, snapOn.payload);

    // Mode B (passenger_gst_enabled=ON with gst_recovery_enabled=OFF) with D-20 unset: since
    // 5780d60 readNonRecoveryGstMode defaults to DRIVER_LIABLE_INFORMATIONAL, so the toggle is
    // allowed and the ride below must still post no recovery-clearing entries.
    const allowedModeB = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED}`,
      headers: checker.headers,
      payload: { status: 'ON' },
    });
    assert.equal(allowedModeB.statusCode, 200, allowedModeB.payload);

    // Complete a Path B ride under Mode B -> ZERO DRIVER_GST_RECOVERY_CLEARING entries, ZERO GST_RECOVERY failures
    const w = await rideWorld(
      app,
      { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE },
      { driver: { paymentModel: 'COMMISSION' } },
    );
    await fundCommissionWalletWithLedger(w.driverId, 500);

    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 34.0837,
        pickupLng: 74.7973,
        dropLat: 34.12,
        dropLng: 74.83,
        paymentMethod: 'CASH',
      },
    });
    const rideId = await acceptRide(app, w, reqRes.json().data.id);
    await finishRide(app, w, rideId, { distanceKm: 5, durationMin: 12 });

    const clearingCount = await db().client.paymentLedgerEntry.count({
      where: { account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING },
    });
    assert.equal(clearingCount, 0);

    const gstFailures = await db().client.commissionCollectionFailure.count({
      where: { rideId, kind: 'GST_RECOVERY' },
    });
    assert.equal(gstFailures, 0);

    const gstStep = await db().client.rideSettlementStep.findUniqueOrThrow({
      where: { rideId_stepType: { rideId, stepType: 'PASSENGER_GST_LIABILITY' } },
    });
    assert.equal(gstStep.status, 'SKIPPED_DRIVER_LIABLE');
  });

  it('T4, T5, T7 — Mode A atomic reservation, manual debit guard, write-once snapshots, append-only revisions, 1x TAX_PAYABLE & all 6 reconciliation invariants green', async () => {
    const maker = await loginAdmin(MAKER_PHONE, MAKER_EMAIL);
    const checker = await loginAdmin(CHECKER_PHONE, CHECKER_EMAIL);
    await setupSgrJurisdiction(maker.headers);

    // T7: Tax config without CA SAC classification is blocked at approval (400 SAC_CLASSIFICATION_REQUIRED)
    const noSac = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tax-configurations',
      headers: maker.headers,
      payload: {
        kind: 'PASSENGER_RIDE_GST',
        ratePct: 5,
        isEnabled: true,
        scopes: [{}],
      },
    });
    assert.equal(noSac.statusCode, 201, noSac.payload);
    const noSacApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tax-configurations/${noSac.json().data.id}/approve`,
      headers: checker.headers,
    });
    assert.equal(noSacApprove.statusCode, 400, noSacApprove.payload);
    assert.equal(noSacApprove.json().error.code, 'SAC_CLASSIFICATION_REQUIRED');

    await seedActiveGlobalConfigs(maker.headers, checker.headers);

    // Enable Mode A flags
    const flagsOn = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/feature-flags',
      headers: checker.headers,
      payload: {
        flags: [
          { key: REV5_PRICING_FLAGS.SNAPSHOT_READ, status: 'ON' },
          { key: REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE, status: 'ON' },
          { key: REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED, status: 'ON' },
          { key: REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION, status: 'ON' },
          { key: REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED, status: 'ON' },
          { key: REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED, status: 'ON' },
        ],
      },
    });
    assert.equal(flagsOn.statusCode, 200, flagsOn.payload);

    // Live pricing summary returns real active rates & dynamically computed combined 12%
    const summaryRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/pricing/summary',
      headers: checker.headers,
    });
    assert.equal(summaryRes.statusCode, 200, summaryRes.payload);
    assert.equal(summaryRes.json().data.activeGlobalBaseline.commission.ratePct, 7);
    assert.equal(summaryRes.json().data.activeGlobalBaseline.passengerGst.ratePct, 5);
    assert.equal(summaryRes.json().data.activeGlobalBaseline.gstRecovery.ratePct, 5);
    assert.equal(summaryRes.json().data.activeGlobalBaseline.combinedDriverDeductionPct, 12);

    const w = await rideWorld(
      app,
      { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE },
      { driver: { paymentModel: 'COMMISSION' } },
    );
    await fundCommissionWalletWithLedger(w.driverId, 100);

    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 34.0837,
        pickupLng: 74.7973,
        dropLat: 34.12,
        dropLng: 74.83,
        paymentMethod: 'CASH',
      },
    });
    const rideId = await acceptRide(app, w, reqRes.json().data.id);

    // T5: Active reservation created at accept time; manual admin debit cannot spend reserved funds!
    const reservation = await db().client.driverWalletReservation.findUniqueOrThrow({
      where: { rideId },
    });
    assert.equal(reservation.status, 'ACTIVE');
    assert.ok(Number(reservation.totalReservedAmount) > 0);

    const walletSvc = container.resolve<CommissionWalletService>('commissionWalletService');
    await assert.rejects(
      async () => {
        await db().transactionManager.execute((tx) =>
          walletSvc.adminDebitInTx(w.driverId, new Decimal(99.5), tx, {
            description: 'Attempt to spend reserved funds',
          }),
        );
      },
      (err: unknown) =>
        (err as { code?: string }).code === 'INSUFFICIENT_AVAILABLE_BALANCE_DUE_TO_RESERVATIONS',
    );

    // T4: Write-once trigger blocks mutation on rides.commission_snapshot
    await assert.rejects(async () => {
      await db().client.$executeRawUnsafe(
        `UPDATE rides SET commission_snapshot = '{"tampered":true}'::jsonb WHERE id = $1::uuid`,
        rideId,
      );
    }, /write-once and immutable/i);

    // Complete Mode A ride
    await finishRide(app, w, rideId, { distanceKm: 5, durationMin: 12 });

    // T4: Append-only trigger blocks UPDATE or DELETE on ride_pricing_revisions
    const rev = await db().client.ridePricingRevision.findFirstOrThrow({ where: { rideId } });
    await assert.rejects(async () => {
      await db().client.$executeRawUnsafe(
        `DELETE FROM ride_pricing_revisions WHERE id = $1::uuid`,
        rev.id,
      );
    }, /strictly append-only/i);

    // T7: TAX_PAYABLE credited STRICTLY 1x, clearing account netted to ₹0.00, all 6 invariants PASS!
    const taxEntries = await db().client.paymentLedgerEntry.findMany({
      where: { referenceId: rideId, account: LEDGER_ACCOUNTS.TAX_PAYABLE, direction: 'CREDIT' },
    });
    assert.equal(taxEntries.length, 1);

    const reconRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/pricing/reconciliation',
      headers: checker.headers,
    });
    assert.equal(reconRes.statusCode, 200, reconRes.payload);
    const recon = reconRes.json().data;
    assert.equal(recon.allPassed, true, JSON.stringify(recon.invariants));
    assert.equal(recon.invariants.length, 6);
  });

  it('T6 — Atomic failure recovery under 10x concurrency & induced pre-COMMIT crash posts exactly 1 debit & clears clearing account', async () => {
    const maker = await loginAdmin(MAKER_PHONE, MAKER_EMAIL);
    const checker = await loginAdmin(CHECKER_PHONE, CHECKER_EMAIL);
    await setupSgrJurisdiction(maker.headers);
    await seedActiveGlobalConfigs(maker.headers, checker.headers);

    const w = await rideWorld(
      app,
      { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE },
      { driver: { paymentModel: 'COMMISSION' } },
    );
    await fundCommissionWalletWithLedger(w.driverId, 200);

    // Create a completed ride with an OPEN GST_RECOVERY failure + G2 clearing debit
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 34.0837,
        pickupLng: 74.7973,
        dropLat: 34.12,
        dropLng: 74.83,
        paymentMethod: 'CASH',
      },
    });
    const rideId = await acceptRide(app, w, reqRes.json().data.id);

    const ledgerSvc = container.resolve<LedgerService>('ledgerService');
    const recoveryAmount = new Decimal(7.8);
    let failureId = '';

    await db().transactionManager.execute(async (tx) => {
      // Seed G2 (1x TAX_PAYABLE) + OPEN GST_RECOVERY failure + FAILED_INSUFFICIENT_BALANCE step
      await ledgerSvc.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING,
            accountRefId: w.driverId,
            direction: 'DEBIT',
            amount: recoveryAmount,
            referenceType: 'RIDE',
            referenceId: rideId,
            description: 'G2 clearing for T6',
          },
          {
            account: LEDGER_ACCOUNTS.TAX_PAYABLE,
            direction: 'CREDIT',
            amount: recoveryAmount,
            referenceType: 'RIDE',
            referenceId: rideId,
            description: 'G2 1x tax liability for T6',
          },
        ],
        tx,
      );
      await tx.rideSettlementStep.create({
        data: {
          rideId,
          stepType: 'PASSENGER_GST_LIABILITY',
          status: 'POSTED',
          amount: recoveryAmount,
        },
      });
      await tx.rideSettlementStep.create({
        data: {
          rideId,
          stepType: 'GST_RECOVERY_DEBIT',
          status: 'FAILED_INSUFFICIENT_BALANCE',
          amount: recoveryAmount,
        },
      });
      const failure = await tx.commissionCollectionFailure.create({
        data: {
          rideId,
          driverId: w.driverId,
          kind: 'GST_RECOVERY',
          amount: recoveryAmount,
          balanceAtAttempt: new Decimal(0),
          status: 'OPEN',
        },
      });
      failureId = failure.id;
    });

    const recoverySvc = container.resolve<SettlementFailureRecoveryService>(
      'settlementFailureRecoveryService',
    );
    const actor = {
      actorId: checker.userId,
      actorEmail: CHECKER_EMAIL,
      actorRole: 'system_admin',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    };

    // 1) Induced crash before COMMIT rolls back atomically — zero wallet/ledger mutations!
    await assert.rejects(
      () =>
        recoverySvc.recoverFailure(failureId, actor, {
          beforeCommitHook: async () => {
            throw new Error('SIMULATED_CRASH_BEFORE_COMMIT');
          },
        }),
      /SIMULATED_CRASH_BEFORE_COMMIT/,
    );
    const afterCrashFailure = await db().client.commissionCollectionFailure.findUniqueOrThrow({
      where: { id: failureId },
    });
    assert.equal(afterCrashFailure.status, 'OPEN');

    // 2) Fire 10 simultaneous recovery requests -> EXACTLY 1 succeeds, 9 fail with 409 FAILURE_ALREADY_RESOLVED!
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/admin/settlement-failures/${failureId}/recover`,
          headers: checker.headers,
        }),
      ),
    );
    const statuses = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ statusCode: number }>).value.statusCode);
    assert.equal(statuses.filter((s) => s === 200).length, 1, `Expected 1x 200, got ${statuses}`);
    assert.equal(statuses.filter((s) => s === 409).length, 9, `Expected 9x 409, got ${statuses}`);

    // Exactly 1 RIDE_GST_RECOVERY wallet txn, TAX_PAYABLE still 1x (never 2x!), clearing netted to ₹0.00!
    const gstTxns = await db().client.driverCommissionWalletTransaction.count({
      where: { rideId, txnType: 'RIDE_GST_RECOVERY' },
    });
    assert.equal(gstTxns, 1);

    const taxCount = await db().client.paymentLedgerEntry.count({
      where: { account: LEDGER_ACCOUNTS.TAX_PAYABLE, direction: 'CREDIT' },
    });
    assert.equal(taxCount, 1);

    const stepAfter = await db().client.rideSettlementStep.findUniqueOrThrow({
      where: { rideId_stepType: { rideId, stepType: 'GST_RECOVERY_DEBIT' } },
    });
    assert.equal(stepAfter.status, 'POSTED');

    const reconRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/pricing/reconciliation',
      headers: checker.headers,
    });
    assert.equal(reconRes.statusCode, 200, reconRes.payload);
    assert.equal(
      reconRes.json().data.allPassed,
      true,
      JSON.stringify(reconRes.json().data.invariants),
    );
  });
});
