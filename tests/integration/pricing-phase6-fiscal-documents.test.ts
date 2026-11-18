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

describe('Phase 6 — Fiscal Documents, Gapless Series, Signed PDFs & CR-03 Templates (integration)', () => {
  let app: FastifyInstance;
  let fiscalService: FiscalDocumentService;

  before(async () => {
    app = await bootApp();
    fiscalService = container.resolve<FiscalDocumentService>('fiscalDocumentService');
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

  async function loginAdmin(
    phone: string,
    email: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const auth = await loginAs(app, phone);
    await grantRole(auth.userId, 'system_admin');
    await db().client.user.update({
      where: { id: auth.userId },
      data: { email, passwordHash: hashPassword(ADMIN_PASSWORD), isEmailVerified: true },
    });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    assert.equal(loginRes.statusCode, 200, loginRes.payload);
    return {
      userId: auth.userId,
      accessToken: loginRes.json().accessToken as string,
    };
  }

  async function seedLegalAndSeries(adminToken: string, cityCode: string) {
    const leRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/legal-entities',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        legalEntityName: 'Zaroorat Mobility Private Limited',
        tradeName: 'Zaroorat',
        pan: 'AAACZ1234A',
        headOfficeAddress: 'Residency Road, Srinagar, J&K 190001',
      },
    });
    assert.equal(leRes.statusCode, 201, leRes.payload);
    const legalEntityId = leRes.json().data.id as string;

    const regRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/legal-entities/${legalEntityId}/gst-registrations`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        gstin: '01AAACZ1234A1Z5',
        stateCode: '01',
        stateName: 'Jammu and Kashmir',
        registrationAddress: 'Residency Road, Srinagar',
      },
    });
    assert.equal(regRes.statusCode, 201, regRes.payload);
    const gstRegistrationId = regRes.json().data.id as string;

    const mapRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/city-supply-registrations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        cityCode,
        supplyKind: 'PASSENGER_RIDE',
        legalEntityId,
        gstRegistrationId,
      },
    });
    assert.equal(mapRes.statusCode, 201, mapRes.payload);

    const fy = getIndianFinancialYear(new Date());
    const seriesRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/document-series',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        gstRegistrationId,
        documentType: 'PASSENGER_TAX_INVOICE',
        financialYear: fy,
        prefix: 'ZRT-JK-INV-',
      },
    });
    assert.equal(seriesRes.statusCode, 201, seriesRes.payload);

    return { legalEntityId, gstRegistrationId, seriesId: seriesRes.json().data.id as string, fy };
  }

  async function seedCompletedRide(opts: {
    world: Awaited<ReturnType<typeof rideWorld>>;
    paymentModel: 'COMMISSION' | 'SUBSCRIPTION';
    cityCode: string;
    passengerGstSnapshot?: Record<string, unknown> | null;
  }) {
    const { world } = opts;

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
        ${JSON.stringify({ cityCode: opts.cityCode })}::jsonb
      )
      RETURNING "id"
    `;
    const requestId = reqRows[0]!.id;

    const rideCode = `ZRT-${Math.floor(100000 + Math.random() * 899999)}`;
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
        'COMPLETED',
        'CASH',
        ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography,
        'Lal Chowk',
        'Hazratbal',
        now(),
        ${opts.paymentModel},
        ${opts.paymentModel === 'COMMISSION' ? 10.92 : null},
        ${opts.passengerGstSnapshot ? JSON.stringify(opts.passengerGstSnapshot) : null}::jsonb,
        now()
      )
      RETURNING "id"
    `;
    const rideId = rideRows[0]!.id;

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
        taxAmount: opts.passengerGstSnapshot ? 7.8 : 0,
        platformFee: 0,
        totalFare: opts.passengerGstSnapshot ? 165.8 : 158.0,
        driverEarning: 147.08,
        platformCommission: opts.paymentModel === 'COMMISSION' ? 10.92 : 0,
        currency: 'INR',
      },
    });

    return { rideId, rideCode, world };
  }

  it('6.1 blocks enabling documents.issue without GST registration & series, then allows it', async () => {
    const admin = await loginAdmin('+919900060001', 'phase6-admin1@zaroorat.test');

    const failRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.DOCUMENTS_ISSUE}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: 'ON' },
    });
    assert.equal(failRes.statusCode, 409, failRes.payload);
    assert.equal(failRes.json().error.code, 'FLAG_DEPENDENCY_UNSATISFIED');

    await seedLegalAndSeries(admin.accessToken, 'SGR');

    const okRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.DOCUMENTS_ISSUE}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: 'ON' },
    });
    assert.equal(okRes.statusCode, 200, okRes.payload);
  });

  it('6.2–6.5 issues gapless immutable documents, skips Path A, blocks SQL mutation, and streams signed PDFs', async () => {
    const admin = await loginAdmin('+919900060002', 'phase6-admin2@zaroorat.test');
    const { gstRegistrationId } = await seedLegalAndSeries(admin.accessToken, 'SGR');
    const world = await rideWorld(app, {
      customer: '+919900061001',
      driver: '+919900062001',
    });

    // Flag OFF by default -> issues nothing
    const ride1 = await seedCompletedRide({
      world,
      paymentModel: 'COMMISSION',
      cityCode: 'SGR',
      passengerGstSnapshot: {
        gstRegistrationId,
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
      },
    });
    const skippedOff = await fiscalService.issueForCompletedRide(ride1.rideId);
    assert.equal(skippedOff.skipped, 'FLAG_OFF');
    assert.equal(skippedOff.documents.length, 0);

    // Enable documents.issue flag
    const flagRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/feature-flags/${REV5_PRICING_FLAGS.DOCUMENTS_ISSUE}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: 'ON' },
    });
    assert.equal(flagRes.statusCode, 200, flagRes.payload);

    // Issue for Ride 1 and replay -> idempotent, sequence #1 only
    const issued1 = await fiscalService.issueForCompletedRide(ride1.rideId);
    assert.equal(issued1.documents.length, 1);
    const doc1 = issued1.documents[0]!;
    assert.equal(doc1.documentNumber, 'ZRT-JK-INV-000001');
    assert.equal(doc1.sequenceNumber, 1);
    assert.equal(doc1.sacCode, '996412');
    assert.equal(doc1.taxableValue, 156);
    assert.equal(doc1.nonTaxableValue, 2);
    assert.equal(doc1.cgstAmount, 3.9);
    assert.equal(doc1.sgstAmount, 3.9);
    assert.equal(doc1.totalTaxAmount, 7.8);
    assert.equal(doc1.totalAmount, 165.8);

    const replay1 = await fiscalService.issueForCompletedRide(ride1.rideId);
    assert.equal(replay1.documents[0]!.documentNumber, 'ZRT-JK-INV-000001');

    // Path A grandfathered ride -> skipped (zero GST invoice issued)
    const ridePathA = await seedCompletedRide({
      world,
      paymentModel: 'SUBSCRIPTION',
      cityCode: 'SGR',
      passengerGstSnapshot: null,
    });
    const skippedPathA = await fiscalService.issueForCompletedRide(ridePathA.rideId);
    assert.equal(skippedPathA.skipped, 'GRANDFATHERED_SUBSCRIPTION');
    assert.equal(skippedPathA.documents.length, 0);

    // Ride 2 -> gapless sequence #2 (NOT #3!)
    const ride2 = await seedCompletedRide({
      world,
      paymentModel: 'COMMISSION',
      cityCode: 'SGR',
      passengerGstSnapshot: {
        gstRegistrationId,
        cityCode: 'SGR',
        supplierStateCode: '01',
        placeOfSupplyStateCode: '07',
        isInterState: true,
        sacCode: '996412',
        taxableValue: 156,
        nonTaxableValue: 2,
        cgstRatePct: 0,
        sgstRatePct: 0,
        igstRatePct: 5,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 7.8,
        taxAmount: 7.8,
        waitingTaxable: false,
        inclusive: false,
      },
    });
    const issued2 = await fiscalService.issueForCompletedRide(ride2.rideId);
    assert.equal(issued2.documents[0]!.documentNumber, 'ZRT-JK-INV-000002');
    assert.equal(issued2.documents[0]!.isInterState, true);
    assert.equal(issued2.documents[0]!.igstAmount, 7.8);

    // 6.4 Immutability trigger blocks direct SQL edit and DELETE
    await assert.rejects(
      db().client.$executeRaw`UPDATE "fiscal_documents" SET "total_amount" = 1.00 WHERE "id" = ${doc1.id}::uuid`,
      /immutable/i,
    );
    await assert.rejects(
      db().client.$executeRaw`DELETE FROM "fiscal_documents" WHERE "id" = ${doc1.id}::uuid`,
      /immutable/i,
    );

    // 6.5 Rider downloads signed PDF; unrelated customer gets 403; tampered token gets 403
    const riderDocsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${ride1.rideId}/fiscal-documents`,
      headers: { authorization: `Bearer ${ride1.world.customer.accessToken}` },
    });
    assert.equal(riderDocsRes.statusCode, 200, riderDocsRes.payload);
    const riderDocs = riderDocsRes.json().data as Array<{
      id: string;
      downloadPath: string;
    }>;
    assert.equal(riderDocs.length, 1);

    const pdfRes = await app.inject({
      method: 'GET',
      url: riderDocs[0]!.downloadPath,
    });
    assert.equal(pdfRes.statusCode, 200);
    assert.equal(pdfRes.headers['content-type'], 'application/pdf');
    assert.ok(pdfRes.rawPayload.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));

    const tamperedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-documents/${doc1.id}/download?token=tampered.signaturevalue12345`,
    });
    assert.equal(tamperedRes.statusCode, 403);

    const stranger = await loginAs(app, '+919900060099');
    const forbiddenRes = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${ride1.rideId}/fiscal-documents`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    assert.equal(forbiddenRes.statusCode, 403);

    // Void doc1 cleanly via audited endpoint
    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fiscal-documents/${doc1.id}/void`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { reason: 'Duplicate customer billing dispute approved by Finance' },
    });
    assert.equal(voidRes.statusCode, 200, voidRes.payload);
    assert.equal(voidRes.json().data.status, 'VOIDED');

    // 6.6 Audited Finance CSV Export writes EXPORT audit log
    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fiscal-documents/export.csv',
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    assert.equal(csvRes.statusCode, 200);
    assert.ok(csvRes.body.includes('ZRT-JK-INV-000001'));
    assert.ok(csvRes.body.includes('ZRT-JK-INV-000002'));
    assert.equal(csvRes.headers['x-export-row-count'], '2');

    const exportAudit = await db().client.adminActivityLog.findFirst({
      where: { action: 'EXPORT', entityType: 'fiscal_document' },
    });
    assert.ok(exportAudit, 'CSV export must write an EXPORT row in admin_activity_logs');
  });

  it('6.6 persists CR-03 compliance templates with placeholder validation, preview gate, and single active constraint', async () => {
    const admin = await loginAdmin('+919900060003', 'phase6-admin3@zaroorat.test');

    // Unknown placeholder rejected with 400
    const badRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/compliance-templates',
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        documentType: 'PASSENGER_TAX_INVOICE',
        name: 'Bad Template',
        fileName: 'bad.html',
        content: '<div>{{invoice_number}} {{forbidden_var}}</div>',
      },
    });
    assert.equal(badRes.statusCode, 400, badRes.payload);
    assert.equal(badRes.json().error.code, 'INVALID_TEMPLATE_PLACEHOLDERS');

    // Upload valid template
    const t1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/compliance-templates',
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        documentType: 'PASSENGER_TAX_INVOICE',
        name: 'J&K GST Passenger Invoice v1',
        fileName: 'jk-invoice-v1.html',
        content:
          '<h1>{{company_legal_name}}</h1><p>{{invoice_number}} · {{sac_code}} · {{total_amount}}</p>',
        versionNote: 'Initial CA-reviewed layout',
      },
    });
    assert.equal(t1Res.statusCode, 201, t1Res.payload);
    const t1Id = t1Res.json().data.id as string;

    // Cannot activate before preview approval
    const earlyActivate = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/compliance-templates/${t1Id}/activate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    assert.equal(earlyActivate.statusCode, 409, earlyActivate.payload);
    assert.equal(earlyActivate.json().error.code, 'TEMPLATE_PREVIEW_NOT_APPROVED');

    // Approve preview then activate
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/compliance-templates/${t1Id}/approve-preview`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    assert.equal(approveRes.statusCode, 200, approveRes.payload);

    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/compliance-templates/${t1Id}/activate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    assert.equal(activateRes.statusCode, 200, activateRes.payload);
    assert.equal(activateRes.json().data.isActive, true);
  });
});
