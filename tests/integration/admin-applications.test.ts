import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { driverConfig } from '../../src/config/driver/driver.config.js';

const ADMIN_PHONE = '+919876544001';
const DRIVER_PHONE = '+919876544002';
const SUPPORT_PHONE = '+919876544003';
const ADMIN_EMAIL = 'app-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin applications (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(async () => {
    await resetState();
  });

  async function loginStaff(phone: string, role: string, email = ADMIN_EMAIL) {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, role);
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    if (loggedIn.statusCode !== 200) {
      throw new Error(`staff login failed: ${loggedIn.payload}`);
    }
    const body = loggedIn.json();
    return {
      userId: body.user.id as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  async function seedPendingApplication(withVerifiedDocs = false) {
    const user = await loginAs(app, DRIVER_PHONE);
    await grantRole(user.userId, 'driver');
    await db().client.userProfile.upsert({
      where: { userId: user.userId },
      create: { userId: user.userId, firstName: 'Pending', lastName: 'Applicant' },
      update: { firstName: 'Pending', lastName: 'Applicant' },
    });
    const driverId = await makeDriver(user.userId, { verified: false });
    await db().client.driverProfile.create({
      data: {
        driverId,
        fullLegalName: 'Pending Applicant',
        city: 'Srinagar',
        state: 'Jammu & Kashmir',
      },
    });

    if (withVerifiedDocs) {
      for (const documentType of driverConfig.requiredDocumentTypes) {
        await db().client.driverDocument.create({
          data: {
            driverId,
            documentType,
            verificationStatus: 'VERIFIED',
            fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
          },
        });
      }
    }

    return { ...user, driverId };
  }

  it('lists pending applications and returns detail for drivers:read', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication();
    const verifiedId = await makeDriver(
      (
        await (async () => {
          const u = await loginAs(app, '+919876544099');
          await grantRole(u.userId, 'driver');
          return u;
        })()
      ).userId,
      { verified: true },
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications',
      headers: admin.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const rows = listed.json().data as Array<{ id: string; applicationStatus: string }>;
    assert.ok(rows.some((row) => row.id === pending.driverId));
    assert.ok(!rows.some((row) => row.id === verifiedId));
    const match = rows.find((row) => row.id === pending.driverId)!;
    assert.equal(match.applicationStatus, 'pending_review');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${pending.driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.driverName, 'Pending Applicant');
    assert.equal(detail.json().data.applicationStatus, 'pending_review');
  });

  it('approves an eligible application with drivers:verify', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication(true);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/approve`,
      headers: admin.authHeader,
      payload: { notes: 'Docs clear' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);
    assert.equal(approved.json().data.applicationStatus, 'approved');

    const driver = await db().client.driver.findUniqueOrThrow({
      where: { id: pending.driverId },
    });
    assert.equal(driver.verificationStatus, 'VERIFIED');

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${pending.driverId}`,
      headers: admin.authHeader,
    });
    assert.equal(gone.statusCode, 409, gone.payload);
  });

  it('rejects an application with drivers:verify', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const pending = await seedPendingApplication();

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/reject`,
      headers: admin.authHeader,
      payload: { notes: 'Incomplete KYC' },
    });
    assert.equal(rejected.statusCode, 200, rejected.payload);
    assert.equal(rejected.json().data.applicationStatus, 'rejected');

    const driver = await db().client.driver.findUniqueOrThrow({
      where: { id: pending.driverId },
    });
    assert.equal(driver.verificationStatus, 'REJECTED');
  });

  it('blocks support from approve without drivers:verify', async () => {
    const support = await loginStaff(SUPPORT_PHONE, 'support', 'support-app@zaroorat.test');
    const pending = await seedPendingApplication(true);

    const driversRead = await db().client.permission.findUniqueOrThrow({
      where: { code: 'drivers:read' },
    });
    const supportRole = await db().client.role.findUniqueOrThrow({ where: { slug: 'support' } });
    await db().client.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: supportRole.id, permissionId: driversRead.id },
      },
      create: { roleId: supportRole.id, permissionId: driversRead.id, effect: 'ALLOW' },
      update: {},
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications',
      headers: support.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${pending.driverId}/approve`,
      headers: support.authHeader,
      payload: { notes: 'Should fail' },
    });
    assert.equal(approved.statusCode, 403, approved.payload);
  });

  it('creates a manual application that appears in apps, drivers, and vehicles after approve', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const nextYear = new Date().getFullYear() + 1;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: admin.authHeader,
      payload: {
        fullName: 'Manual Applicant',
        mobileNumber: '+919876544088',
        email: 'manual.applicant@zaroorat.test',
        gender: 'MALE',
        dateOfBirth: '1994-05-20',
        preferredLanguage: 'English',
        country: 'India',
        state: 'Jammu & Kashmir',
        city: 'Srinagar',
        postcode: '190001',
        addressLine1: 'Residency Road 12',
        emergencyContactName: 'Brother',
        emergencyContactNumber: '+919876544089',
        profilePhotoUrl: 'https://example.invalid/profile.jpg',
        aadhaarNumber: '123412341234',
        aadhaarFrontUrl: 'https://example.invalid/aadhaar-front.jpg',
        aadhaarBackUrl: 'https://example.invalid/aadhaar-back.jpg',
        panNumber: 'ABCDE1234F',
        panUrl: 'https://example.invalid/pan.jpg',
        driverSelfieUrl: 'https://example.invalid/selfie.jpg',
        vehicleType: 'cab',
        vehicleCategory: 'Sedan',
        brand: 'Maruti Suzuki',
        model: 'Swift',
        color: 'White',
        registrationNumber: 'JK-01-MN-8899',
        manufacturingYear: 2022,
        seatCapacity: 4,
        licenseNo: 'JK1420150001234',
        licenseIssueDate: '2020-01-01',
        licenseExpiry: `${nextYear}-01-01`,
        licenseFrontUrl: 'https://example.invalid/license-front.jpg',
        licenseBackUrl: 'https://example.invalid/license-back.jpg',
        rcNumber: 'RC-JK01MN8899',
        rcUrl: 'https://example.invalid/rc.jpg',
        insuranceNo: 'INS-8899',
        insuranceExpiry: `${nextYear}-06-01`,
        insuranceUrl: 'https://example.invalid/insurance.jpg',
        permitNo: 'PRM-8899',
        permitExpiry: `${nextYear}-06-01`,
        permitUrl: 'https://example.invalid/permit.jpg',
        pollutionNo: 'PUC-8899',
        pollutionExpiry: `${nextYear}-06-01`,
        pollutionUrl: 'https://example.invalid/puc.jpg',
        bankAccountName: 'Manual Applicant',
        bankAccountNumber: '123456789012',
        bankIfsc: 'SBIN0001234',
        bankName: 'State Bank of India',
        registrationAction: 'submit_for_review',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const application = created.json().data;
    assert.equal(application.applicationStatus, 'pending_review');
    assert.equal(application.source, 'admin_manual');
    assert.ok(
      application.documents.some((d: { fileUrl: string }) => d.fileUrl.includes('license-front')),
    );
    assert.equal(application.vehicle?.registrationPlate, 'JK-01-MN-8899');

    const apps = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications',
      headers: admin.authHeader,
    });
    assert.equal(apps.statusCode, 200, apps.payload);
    assert.ok(apps.json().data.some((row: { id: string }) => row.id === application.id));

    const vehiclesBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/vehicles',
      headers: admin.authHeader,
    });
    assert.equal(vehiclesBefore.statusCode, 200, vehiclesBefore.payload);
    assert.ok(
      vehiclesBefore
        .json()
        .data.some(
          (row: { registrationPlate: string }) => row.registrationPlate === 'JK-01-MN-8899',
        ),
    );

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${application.id}/approve`,
      headers: admin.authHeader,
      payload: { notes: 'Manual KYC clear' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);
    assert.equal(approved.json().data.applicationStatus, 'approved');

    const drivers = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/drivers?status=active',
      headers: admin.authHeader,
    });
    assert.equal(drivers.statusCode, 200, drivers.payload);
    assert.ok(drivers.json().data.some((row: { id: string }) => row.id === application.id));

    const vehiclesAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/vehicles',
      headers: admin.authHeader,
    });
    assert.equal(vehiclesAfter.statusCode, 200, vehiclesAfter.payload);
    const vehicle = vehiclesAfter
      .json()
      .data.find((row: { registrationPlate: string }) => row.registrationPlate === 'JK-01-MN-8899');
    assert.ok(vehicle);
    assert.equal(vehicle.verificationStatus, 'VERIFIED');
  });
});
