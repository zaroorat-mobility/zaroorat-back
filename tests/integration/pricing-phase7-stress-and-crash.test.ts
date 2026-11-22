import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCityWithBoundary, grantRole } from './helpers/fixtures.js';
import { rideWorld } from './helpers/ride-flow.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import {
  FiscalDocumentService,
  REV5_PRICING_FLAGS,
  getIndianFinancialYear,
} from '../../src/modules/pricing/index.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import { LEDGER_ACCOUNTS } from '../../src/modules/payments/constants/payment.constants.js';
import type { CommissionWalletService } from '../../src/modules/payments/services/commission-wallet/commission-wallet.service.js';
import type { SettlementFailureRecoveryService } from '../../src/modules/payments/services/commission-wallet/settlement-failure-recovery.service.js';
import type { PricingReconciliationService } from '../../src/modules/payments/services/commission-wallet/pricing-reconciliation.service.js';
import type { LedgerService } from '../../src/modules/payments/services/ledger/ledger.service.js';

const ADMIN_PASSWORD = 'Admin@12345';
const SGR_BOUNDS: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

describe('Phase 7 — Production 50x Concurrency Stress, Crash Injection & Zero-Drift Verification', () => {
  let app: FastifyInstance;
  let fiscalService: FiscalDocumentService;
  let commissionWalletService: CommissionWalletService;
  let recoveryService: SettlementFailureRecoveryService;
  let reconciliationService: PricingReconciliationService;
  let ledgerService: LedgerService;

  before(async () => {
    app = await bootApp();
    fiscalService = container.resolve<FiscalDocumentService>('fiscalDocumentService');
    commissionWalletService = container.resolve<CommissionWalletService>('commissionWalletService');
    recoveryService = container.resolve<SettlementFailureRecoveryService>(
      'settlementFailureRecoveryService',
    );
    reconciliationService = container.resolve<PricingReconciliationService>(
      'pricingReconciliationService',
    );
    ledgerService = container.resolve<LedgerService>('ledgerService');
  });

  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
    await ensureCityWithBoundary('SGR', 'Srinagar', SGR_BOUNDS);
    await db().client.city.updateMany({
      where: { code: 'SGR' },
      data: { stateCode: '01', stateName: 'Jammu and Kashmir' },
    });
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
  });

  async function loginAdmin(phone: string, email: string) {
    const auth = await loginAs(app, phone);
    await grantRole(auth.userId, 'system_admin');
    await db().client.user.update({
      where: { id: auth.userId },
      data: { email, passwordHash: hashPassword(ADMIN_PASSWORD), isEmailVerified: true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return { userId: auth.userId, token: res.json().accessToken as string };
  }

  async function fundWalletWithLedger(driverId: string, amountRupees: number) {
    // Reset makeDriver's un-ledgered 1,000,000 fixture balance so Invariant 1 tracks 0.00 drift
    await db().client.driverCommissionWallet.updateMany({
      where: { driverId },
      data: { balance: new Decimal(0) },
    });
    const dec = new Decimal(amountRupees);
    await db().transactionManager.execute(async (tx) => {
      await commissionWalletService.creditInTx(driverId, dec, tx, {
        referenceType: 'RECHARGE',
        description: 'Phase 7 ledger-backed top-up',
      });
      await ledgerService.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.GATEWAY_CLEARING,
            direction: 'DEBIT',
            amount: dec,
            referenceType: 'RECHARGE',
            description: 'Phase 7 test top-up clearing',
          },
          {
            account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
            accountRefId: driverId,
            direction: 'CREDIT',
            amount: dec,
            referenceType: 'RECHARGE',
            description: 'Phase 7 test top-up wallet credit',
          },
        ],
        tx,
      );
    });
  }

  async function seedRideRecord(
    world: Awaited<ReturnType<typeof rideWorld>>,
    opts: {
      status: 'ACCEPTED' | 'COMPLETED';
      index: number;
      gstRegistrationId?: string;
    },
  ): Promise<string> {
    const reqRows = await db().client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "ride_requests" (
        "id", "customer_id", "vehicle_type_id", "pickup_lat", "pickup_lng",
        "pickup_location", "pickup_address", "drop_address",
        "estimated_distance_km", "estimated_duration_min",
        "quoted_fare", "status", "pricing_snapshot"
      ) VALUES (
        gen_random_uuid(),
        ${world.customer.userId}::uuid,
        ${world.vehicleTypeId}::uuid,
        34.0837,
        74.7973,
        ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography,
        'Lal Chowk',
        'Hazratbal',
        8.00,
        20,
        165.80,
        'MATCHED',
        ${JSON.stringify({ cityCode: 'SGR' })}::jsonb
      )
      RETURNING "id"
    `;
    const requestId = reqRows[0]!.id;
    const rideCode = `STRESS-${opts.index}-${Math.floor(10000 + Math.random() * 89999)}`;
    const gstSnap = opts.gstRegistrationId
      ? {
          gstRegistrationId: opts.gstRegistrationId,
          cityCode: 'SGR',
          supplierStateCode: '01',
          placeOfSupplyStateCode: '01',
          isInterState: false,
          sacCode: '996412',
          taxableValue: 156,
          nonTaxableValue: 2,
          cgstRatePct: 2.5,
          sgstRatePct: 2.5,
          igstRatePct: 0,
          cgstAmount: 3.9,
          sgstAmount: 3.9,
          igstAmount: 0,
          taxAmount: 7.8,
          waitingTaxable: false,
          inclusive: false,
        }
      : null;

    const rideRows = await db().client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "rides" (
        "id", "ride_code", "request_id", "customer_id", "driver_id",
        "vehicle_id", "vehicle_type_id", "status", "payment_method",
        "pickup_location", "pickup_address", "drop_address",
        "completed_at", "driver_payment_model", "commission_amount",
        "passenger_gst_snapshot", "updated_at"
      ) VALUES (
        gen_random_uuid(),
        ${rideCode},
        ${requestId}::uuid,
        ${world.customer.userId}::uuid,
        ${world.driverId}::uuid,
        ${world.vehicleId}::uuid,
        ${world.vehicleTypeId}::uuid,
        ${opts.status}::"RideStatus",
        'CASH',
        ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography,
        'Lal Chowk',
        'Hazratbal',
        ${opts.status === 'COMPLETED' ? new Date() : null},
        'COMMISSION',
        10.92,
        ${gstSnap ? JSON.stringify(gstSnap) : null}::jsonb,
        now()
      )
      RETURNING "id"
    `;
    const rideId = rideRows[0]!.id;

    if (opts.status === 'COMPLETED') {
      await db().client.rideFare.create({
        data: {
          rideId,
          baseFare: 30,
          distanceFare: 80,
          timeFare: 20,
          waitingCharge: 2,
          surgeMultiplier: 1.2,
          surgeAmount: 26,
          subtotal: 158,
          discountAmount: 0,
          taxAmount: 7.8,
          platformFee: 0,
          totalFare: 165.8,
          driverEarning: 147.08,
          platformCommission: 10.92,
          currency: 'INR',
        },
      });
    }
    return rideId;
  }

  it('S1: 50x concurrent gapless fiscal document issuance + 50x replay storm produces 1..50 with 0 gaps and 0 duplicates', async () => {
    const admin = await loginAdmin('+919900070001', 'phase7-s1@zaroorat.test');
    const world = await rideWorld(app, {
      customer: '+919900071001',
      driver: '+919900072001',
    });

    const leRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/legal-entities',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        legalEntityName: 'Zaroorat Stress Entity Pvt Ltd',
        pan: 'AAACZ7777A',
        headOfficeAddress: 'Srinagar, J&K',
      },
    });
    const legalEntityId = leRes.json().data.id as string;

    const regRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/legal-entities/${legalEntityId}/gst-registrations`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        gstin: '01AAACZ7777A1Z5',
        stateCode: '01',
        stateName: 'Jammu and Kashmir',
        registrationAddress: 'Srinagar, J&K',
      },
    });
    const gstRegistrationId = regRes.json().data.id as string;

    const fy = getIndianFinancialYear(new Date());
    const seriesRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/document-series',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        gstRegistrationId,
        documentType: 'PASSENGER_TAX_INVOICE',
        financialYear: fy,
        prefix: 'ZRT-STRESS-',
      },
    });
    const seriesId = seriesRes.json().data.id as string;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.DOCUMENTS_ISSUE}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'ON' },
    });

    const rideIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      rideIds.push(await seedRideRecord(world, { status: 'COMPLETED', index: i, gstRegistrationId }));
    }

    // Fire 50 simultaneous issuance calls on ONE shared document_series row
    const results = await Promise.all(
      rideIds.map((id) => fiscalService.issueForCompletedRide(id)),
    );
    assert.equal(results.length, 50);
    for (const r of results) {
      assert.equal(r.documents.length, 1);
    }

    // Fire a 50x duplicate replay storm concurrently
    await Promise.all(rideIds.map((id) => fiscalService.issueForCompletedRide(id)));

    const series = await db().client.documentSeries.findUniqueOrThrow({ where: { id: seriesId } });
    assert.equal(series.lastSequence, 50n, 'last_sequence must be exact 50');

    const docs = await db().client.fiscalDocument.findMany({
      where: { seriesId },
      orderBy: { sequenceNumber: 'asc' },
      select: { sequenceNumber: true, documentNumber: true },
    });
    assert.equal(docs.length, 50, 'Must have exactly 50 documents');
    for (let i = 0; i < 50; i++) {
      assert.equal(Number(docs[i]!.sequenceNumber), i + 1, `Gapless sequence #${i + 1}`);
      assert.equal(docs[i]!.documentNumber, `ZRT-STRESS-${String(i + 1).padStart(6, '0')}`);
    }
  });

  it('S2: 50x concurrent settlement failure recovery stampede debits wallet ONCE with 0.00 reconciliation drift', async () => {
    const admin = await loginAdmin('+919900070002', 'phase7-s2@zaroorat.test');
    const world = await rideWorld(app, {
      customer: '+919900071002',
      driver: '+919900072002',
    });
    await fundWalletWithLedger(world.driverId, 100);

    const rideId = await seedRideRecord(world, { status: 'COMPLETED', index: 101 });
    await db().client.rideSettlementStep.create({
      data: {
        rideId,
        stepType: 'COMMISSION_DEBIT',
        status: 'FAILED_INSUFFICIENT_BALANCE',
        amount: new Decimal(25),
      },
    });
    const failure = await db().client.commissionCollectionFailure.create({
      data: {
        rideId,
        driverId: world.driverId,
        kind: 'COMMISSION',
        amount: new Decimal(25),
        balanceAtAttempt: new Decimal(0),
        status: 'OPEN',
      },
    });

    // Stampede: 50 concurrent recovery requests for the exact same failure ID
    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        recoveryService.recoverFailure(failure.id, {
          actorId: admin.userId,
          ipAddress: '127.0.0.1',
          userAgent: 'phase7-stress-test',
        }),
      ),
    );
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'At least one recovery call must succeed');

    const wallet = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId: world.driverId },
    });
    assert.equal(Number(wallet.balance), 75, 'Wallet must be debited ONCE (100 - 25 = 75)');

    const commTxns = await db().client.driverCommissionWalletTransaction.count({
      where: { rideId, txnType: 'RIDE_COMMISSION' },
    });
    assert.equal(commTxns, 1, 'Exactly one RIDE_COMMISSION txn allowed');

    const report = await reconciliationService.runDailyInvariants();
    assert.equal(report.allPassed, true, JSON.stringify(report.invariants, null, 2));
  });

  it('S3: 50x concurrent manual admin debits respect active wallet reservation and never violate balance >= reserved', async () => {
    const world = await rideWorld(app, {
      customer: '+919900071003',
      driver: '+919900072003',
    });
    await fundWalletWithLedger(world.driverId, 100);

    const activeRideId = await seedRideRecord(world, { status: 'ACCEPTED', index: 201 });
    await db().transactionManager.execute(async (tx) => {
      await commissionWalletService.reserveForRideInTx(
        {
          driverId: world.driverId,
          rideId: activeRideId,
          commissionAmount: new Decimal(45),
          gstRecoveryAmount: new Decimal(15),
        },
        tx,
      );
    });

    // Wallet has 100, reserved 60 -> available = 40. Fire 50 parallel 15-rupee debits!
    // At most 2 debits (30 <= 40) can succeed; remaining 48 must fail!
    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, idx) =>
        db().transactionManager.execute(async (tx) => {
          const result = await commissionWalletService.adminDebitInTx(
            world.driverId,
            new Decimal(15),
            tx,
            { referenceId: null, description: `Stress debit #${idx}` },
          );
          await ledgerService.postTransactionGroup(
            [
              {
                account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
                accountRefId: world.driverId,
                direction: 'DEBIT',
                amount: new Decimal(15),
                referenceType: 'ADMIN_DEBIT',
                referenceId: result.id,
                description: `Stress debit #${idx}`,
              },
              {
                account: LEDGER_ACCOUNTS.PLATFORM_COMMISSION,
                direction: 'CREDIT',
                amount: new Decimal(15),
                referenceType: 'ADMIN_DEBIT',
                referenceId: result.id,
                description: `Stress debit offset #${idx}`,
              },
            ],
            tx,
          );
        }),
      ),
    );

    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(succeeded.length, 2, 'Exactly 2 debits (₹30) fit inside ₹40 available balance');
    assert.equal(rejected.length, 48, 'All 48 excess debits must be blocked by reservation guard');

    const wallet = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId: world.driverId },
    });
    assert.equal(Number(wallet.balance), 70, 'Final balance must be ₹70 (>= ₹60 reserved)');

    const report = await reconciliationService.runDailyInvariants();
    assert.equal(report.allPassed, true, JSON.stringify(report.invariants, null, 2));
  });

  it('S4: pre-commit crash rolls back wallet debit & reservation consumption 100%, and post-crash retry succeeds cleanly', async () => {
    const world = await rideWorld(app, {
      customer: '+919900071004',
      driver: '+919900072004',
    });
    await fundWalletWithLedger(world.driverId, 100);
    const rideId = await seedRideRecord(world, { status: 'ACCEPTED', index: 301 });

    await db().transactionManager.execute(async (tx) => {
      await commissionWalletService.reserveForRideInTx(
        {
          driverId: world.driverId,
          rideId,
          commissionAmount: new Decimal(20),
          gstRecoveryAmount: new Decimal(0),
        },
        tx,
      );
    });

    // Inject hard crash AFTER consuming reservation & debiting wallet, BEFORE COMMIT
    await assert.rejects(
      db().transactionManager.execute(async (tx) => {
        await tx.driverWalletReservation.update({
          where: { rideId },
          data: { status: 'CONSUMED', resolvedAt: new Date() },
        });
        await commissionWalletService.deductInTx(world.driverId, rideId, new Decimal(20), tx);
        throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT');
      }),
      /SIMULATED_PROCESS_CRASH_BEFORE_COMMIT/,
    );

    // Verify 100% rollback
    const resAfterCrash = await db().client.driverWalletReservation.findUniqueOrThrow({
      where: { rideId },
    });
    assert.equal(resAfterCrash.status, 'ACTIVE', 'Reservation must remain ACTIVE after crash rollback');
    const walletAfterCrash = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId: world.driverId },
    });
    assert.equal(Number(walletAfterCrash.balance), 100, 'Wallet balance must be untouched after crash');

    // Post-crash clean retry succeeds atomically
    await db().transactionManager.execute(async (tx) => {
      await tx.ride.update({
        where: { id: rideId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await tx.driverWalletReservation.update({
        where: { rideId },
        data: { status: 'CONSUMED', resolvedAt: new Date() },
      });
      const deduction = await commissionWalletService.deductInTx(
        world.driverId,
        rideId,
        new Decimal(20),
        tx,
      );
      assert.equal(deduction.outcome, 'DEDUCTED');
      const ledgerEntries = await ledgerService.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
            accountRefId: world.driverId,
            direction: 'DEBIT',
            amount: new Decimal(20),
            referenceType: 'RIDE_COMMISSION',
            referenceId: rideId,
            description: 'Post-crash retry commission debit',
          },
          {
            account: LEDGER_ACCOUNTS.PLATFORM_COMMISSION,
            direction: 'CREDIT',
            amount: new Decimal(20),
            referenceType: 'RIDE_COMMISSION',
            referenceId: rideId,
            description: 'Post-crash retry commission revenue',
          },
        ],
        tx,
      );
      await tx.rideSettlementStep.create({
        data: {
          rideId,
          stepType: 'COMMISSION_DEBIT',
          status: 'POSTED',
          amount: new Decimal(20),
          walletTxnId: deduction.transaction.id,
          ledgerGroupId: ledgerEntries[0]!.entryGroup,
        },
      });
    });

    const walletFinal = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId: world.driverId },
    });
    assert.equal(Number(walletFinal.balance), 80);

    const report = await reconciliationService.runDailyInvariants();
    assert.equal(report.allPassed, true, JSON.stringify(report.invariants, null, 2));
  });
});
