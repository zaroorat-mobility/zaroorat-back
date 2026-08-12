import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { createApp } from '../../src/app/app.js';
import {
  deviceListResponse,
  errorResponseSchema,
  sendOtpResponse,
  sessionListResponse,
  tokenPairResponse,
  verifyOtpResponse,
} from '../../src/modules/auth/schemas/auth.responses.js';
import {
  accountResponse,
  contactListResponse,
  deletionRequestResponse,
  phoneChangeChallengeResponse,
  phoneChangeResultResponse,
  placeListResponse,
  profileResponse,
} from '../../src/modules/users/schemas/user.responses.js';
import {
  createUploadResponse,
  fileMetadataResponse,
  readUrlResponse,
} from '../../src/modules/files/http/file.responses.js';

async function serialize(schema: object, payload: unknown): Promise<unknown> {
  const app = Fastify();
  app.get('/probe', { schema: { response: { 200: schema } } }, async () => payload);
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/probe' });
  await app.close();
  assert.equal(response.statusCode, 200, response.payload);
  return response.json();
}

const ISO = '2026-08-08T10:00:00.000Z';
const UUID = '00000000-0000-7000-8000-000000000001';

const contracts: [string, object, Record<string, unknown> | unknown[]][] = [
  [
    'POST /auth/otp/send',
    sendOtpResponse,
    { challengeId: UUID, expiresInSec: 300, resendAvailableInSec: 60 },
  ],
  [
    'POST /auth/otp/verify',
    verifyOtpResponse,
    {
      accessToken: 'a.b.c',
      accessTokenExpiresInSec: 900,
      refreshToken: 'opaque',
      refreshTokenExpiresInSec: 2_592_000,
      user: { id: UUID, status: 'ACTIVE', roles: ['customer'], isNew: false },
    },
  ],
  [
    'POST /auth/token/refresh',
    tokenPairResponse,
    {
      accessToken: 'a.b.c',
      accessTokenExpiresInSec: 900,
      refreshToken: 'opaque',
      refreshTokenExpiresInSec: 2_592_000,
    },
  ],
  [
    'GET /auth/me/sessions',
    sessionListResponse,
    {
      sessions: [
        {
          id: UUID,
          deviceId: UUID,
          ipAddress: '203.0.113.7',
          userAgent: 'Zaroorat/1.0',
          loginMethod: 'otp',
          createdAt: new Date(ISO),
          lastSeenAt: new Date(ISO),
          expiresAt: new Date(ISO),
          current: true,
        },

        {
          id: UUID,
          deviceId: null,
          ipAddress: null,
          userAgent: null,
          loginMethod: null,
          createdAt: new Date(ISO),
          lastSeenAt: null,
          expiresAt: new Date(ISO),
          current: false,
        },
      ],
    },
  ],
  [
    'GET /auth/me/devices',
    deviceListResponse,
    {
      devices: [
        {
          id: UUID,
          deviceId: 'handset-1',
          platform: 'ANDROID',
          trustState: 'REGISTERED',
          isRooted: false,
          isJailbroken: false,
          appVersion: '1.2.3',
          osVersion: '14',
          lastSeenAt: new Date(ISO),
          createdAt: new Date(ISO),
          current: true,
        },
        {
          id: UUID,
          deviceId: null,
          platform: null,
          trustState: 'REVOKED',
          isRooted: true,
          isJailbroken: false,
          appVersion: null,
          osVersion: null,
          lastSeenAt: null,
          createdAt: new Date(ISO),
          current: false,
        },
      ],
    },
  ],
  [
    'GET /users/me',
    accountResponse,
    {
      id: UUID,
      phoneNumber: '+919876543210',
      email: null,
      isPhoneVerified: true,
      isEmailVerified: false,
      status: 'ACTIVE',
      roles: ['customer'],
      createdAt: new Date(ISO),
      lastLoginAt: new Date(ISO),
      profile: {
        firstName: 'Priya',
        lastName: null,
        dateOfBirth: '1994-03-11',
        gender: 'FEMALE',
        profileImageFileId: UUID,
        languageCode: 'hi',
        referralCode: 'ZR-4821',
      },
    },
  ],
  [
    'PATCH /users/me/profile',
    profileResponse,
    {
      firstName: null,
      lastName: null,
      dateOfBirth: null,
      gender: null,
      profileImageFileId: null,
      languageCode: 'en',
      referralCode: null,
    },
  ],
  [
    'POST /users/me/phone/change',
    phoneChangeChallengeResponse,
    { challengeId: UUID, expiresInSec: 300, resendAvailableInSec: 60 },
  ],
  [
    'POST /users/me/phone/verify',
    phoneChangeResultResponse,
    {
      accessToken: 'a.b.c',
      accessTokenExpiresInSec: 900,
      refreshToken: 'opaque',
      refreshTokenExpiresInSec: 2_592_000,
      user: { id: UUID, phoneNumber: '+919000000001', status: 'ACTIVE' },
    },
  ],
  [
    'GET /users/me/emergency-contacts',
    contactListResponse,
    [
      {
        id: UUID,
        contactName: 'Amma',
        phoneNumber: '+919000000002',
        relationship: 'Mother',
        priority: 1,
        createdAt: new Date(ISO),
      },
      {
        id: UUID,
        contactName: 'Neighbour',
        phoneNumber: '+919000000003',
        relationship: null,
        priority: 2,
        createdAt: new Date(ISO),
      },
    ],
  ],
  [
    'GET /users/me/saved-places',
    placeListResponse,
    [
      {
        id: UUID,
        label: 'Home',
        address: '12 MG Road',
        buildingName: null,
        landmark: null,
        floor: '3',
        instructions: null,
        latitude: 12.9716,
        longitude: 77.5946,
        createdAt: new Date(ISO),
      },
      {
        id: UUID,
        label: 'Work',
        address: null,
        buildingName: null,
        landmark: null,
        floor: null,
        instructions: null,
        latitude: null,
        longitude: null,
        createdAt: new Date(ISO),
      },
    ],
  ],
  ['POST /users/me/delete-request', deletionRequestResponse, { scheduledFor: ISO }],
  [
    'POST /files',
    createUploadResponse,
    {
      fileId: UUID,
      status: 'PENDING',
      upload: {
        method: 'PUT',
        url: 'https://bucket.s3.amazonaws.com/pi/2026/08/abc.jpg?X-Amz-Signature=x',
        headers: {
          'Content-Type': 'image/jpeg',
          'x-amz-server-side-encryption': 'AES256',
        },
        expiresAt: new Date(ISO),
      },
    },
  ],
  [
    'POST /files/{id}/complete',
    fileMetadataResponse,
    {
      fileId: UUID,
      status: 'READY',
      purpose: 'PROFILE_IMAGE',
      contentType: 'image/jpeg',
      sizeBytes: 51_200,
      checksumSha256: 'a'.repeat(64),
      createdAt: new Date(ISO),
    },
  ],
  [
    'GET /files/{id} (no checksum declared)',
    fileMetadataResponse,
    {
      fileId: UUID,
      status: 'READY',
      purpose: 'DRIVER_DOCUMENT',
      contentType: 'application/pdf',
      sizeBytes: 204_800,
      checksumSha256: null,
      createdAt: new Date(ISO),
    },
  ],
  [
    'GET /files/{id}/url',
    readUrlResponse,
    {
      url: 'https://bucket.s3.amazonaws.com/pi/2026/08/abc.jpg?X-Amz-Signature=y',
      expiresAt: new Date(ISO),
      contentType: 'image/jpeg',
    },
  ],
  [
    'error envelope',
    errorResponseSchema,
    {
      error: {
        code: 'OTP_LOCKED',
        messageKey: 'auth.otp_locked',
        message: 'Too many incorrect attempts; try again later',
        requestId: 'req-1',
        retryAfterSec: 900,
        details: [{ field: 'phoneNumber', code: 'INVALID_FORMAT' }],
      },
    },
  ],
];

function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => leafPaths(item, `${prefix}[]`));
  if (value === null || typeof value !== 'object' || value instanceof Date) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('response schemas do not silently drop fields', () => {
  for (const [name, schema, payload] of contracts) {
    it(`${name} serializes every field it is given`, async () => {
      const serialized = await serialize(schema, payload);

      const sent = new Set(leafPaths(payload));
      const received = new Set(leafPaths(serialized));
      const dropped = [...sent].filter((path) => !received.has(path));

      assert.deepEqual(dropped, [], `${name}: the response schema is deleting these fields`);
    });
  }

  it('renders Date columns as ISO-8601 strings, not objects', async () => {
    const result = (await serialize(sessionListResponse, {
      sessions: [
        {
          id: UUID,
          deviceId: null,
          ipAddress: null,
          userAgent: null,
          loginMethod: null,
          createdAt: new Date(ISO),
          lastSeenAt: new Date(ISO),
          expiresAt: new Date(ISO),
          current: true,
        },
      ],
    })) as { sessions: { createdAt: unknown; lastSeenAt: unknown }[] };

    assert.equal(result.sessions[0]?.createdAt, ISO);
    assert.equal(result.sessions[0]?.lastSeenAt, ISO, 'nullable dates too');
  });

  it('keeps a null in a nullable field rather than dropping the key', async () => {
    const result = (await serialize(profileResponse, {
      firstName: null,
      lastName: null,
      dateOfBirth: null,
      gender: null,
      profileImageFileId: null,
      languageCode: null,
      referralCode: null,
    })) as Record<string, unknown>;

    for (const key of ['firstName', 'dateOfBirth', 'gender', 'languageCode']) {
      assert.ok(key in result, `${key} must be present as null`);
      assert.equal(result[key], null);
    }
  });
});

describe('published OpenAPI document', () => {
  let app: FastifyInstance;
  let spec: {
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  };

  before(async () => {
    app = await createApp();
    await app.ready();
    spec = app.swagger() as typeof spec;
  });

  after(async () => {
    await app.close();
  });

  const authPaths = [
    '/api/v1/auth/otp/send',
    '/api/v1/auth/otp/verify',
    '/api/v1/auth/token/refresh',
    '/api/v1/auth/logout',
    '/api/v1/auth/me/sessions',
    '/api/v1/auth/me/sessions/{id}',
    '/api/v1/auth/me/devices',
    '/api/v1/auth/me/devices/{id}',
  ];

  const filePaths = [
    '/api/v1/files/',
    '/api/v1/files/{id}',
    '/api/v1/files/{id}/complete',
    '/api/v1/files/{id}/url',
  ];

  const userPaths = [
    '/api/v1/users/me',
    '/api/v1/users/me/profile',
    '/api/v1/users/me/phone/change',
    '/api/v1/users/me/phone/verify',
    '/api/v1/users/me/emergency-contacts',
    '/api/v1/users/me/emergency-contacts/{id}',
    '/api/v1/users/me/saved-places',
    '/api/v1/users/me/saved-places/{id}',
    '/api/v1/users/me/deactivate',
    '/api/v1/users/me/delete-request',
  ];

  for (const path of [...authPaths, ...userPaths, ...filePaths]) {
    it(`documents ${path}`, () => {
      assert.ok(spec.paths[path], `${path} is missing from the spec`);
    });
  }

  it('gives every AUTH and USER operation a documented success response', () => {
    const undocumented: string[] = [];
    for (const path of [...authPaths, ...userPaths, ...filePaths]) {
      for (const [method, operation] of Object.entries(spec.paths[path] ?? {})) {
        const codes = Object.keys(operation.responses ?? {});
        if (!codes.some((code) => code.startsWith('2'))) {
          undocumented.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(undocumented, []);
  });

  it('documents the error envelope on every operation that can fail', () => {
    const missing: string[] = [];
    for (const path of [...authPaths, ...userPaths, ...filePaths]) {
      for (const [method, operation] of Object.entries(spec.paths[path] ?? {})) {
        const codes = Object.keys(operation.responses ?? {});
        if (!codes.some((code) => code.startsWith('4') || code.startsWith('5'))) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('documents 404 on the two endpoints that address a session or device by id', () => {
    for (const path of ['/api/v1/auth/me/sessions/{id}', '/api/v1/auth/me/devices/{id}']) {
      const codes = Object.keys(spec.paths[path]?.delete?.responses ?? {});
      assert.ok(codes.includes('404'), `${path} must document 404`);
    }
  });

  it('documents 403 on OTP verify, where a closed account is turned away', () => {
    const codes = Object.keys(spec.paths['/api/v1/auth/otp/verify']?.post?.responses ?? {});
    assert.ok(codes.includes('403'));
  });
});
