import { filePurposePolicy } from '@config/file/file.config.js';
import { errorResponseSchema } from '@modules/auth/schemas/auth.responses';

const PURPOSES = Object.keys(filePurposePolicy);

export const fileErrorResponseSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        ...errorResponseSchema.properties.error.properties,
        module: {
          type: 'string',
          description: 'For FILE_IN_USE: the module whose live row still references this file.',
        },
      },
      required: [...errorResponseSchema.properties.error.required],
    },
  },
  required: ['error'],
} as const;

export const noContentResponse = { type: 'null', description: 'No content' } as const;

export const fileIdParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export const idempotencyHeaderSchema = {
  type: 'object',
  properties: {
    'idempotency-key': {
      type: 'string',
      description: 'Unique key for request idempotency. Required.',
    },
  },
} as const;

export const readUrlQuerySchema = {
  type: 'object',
  properties: {
    disposition: {
      type: 'string',
      enum: ['inline', 'attachment'],
      default: 'inline',
      description: 'Content-Disposition the signed URL will serve the object with',
    },
  },
} as const;

export const createUploadBodySchema = {
  type: 'object',
  properties: {
    purpose: {
      type: 'string',
      enum: PURPOSES,
      description: 'Required. Decides the allowed MIME types, size cap, and retention rule.',
    },
    fileName: {
      type: 'string',
      maxLength: 1024,
      description: 'Required. Sanitized server-side; the extension is taken from contentType.',
    },
    contentType: {
      type: 'string',
      maxLength: 255,
      description:
        'Required. Must be allowed for the purpose, and is re-checked against the ' +
        'stored object’s magic bytes at completion.',
    },
    sizeBytes: {
      type: 'integer',
      minimum: 1,
      description: 'Required. Declared size; the actual object is re-measured at completion.',
    },
    checksumSha256: {
      type: 'string',
      description: 'Optional lowercase hex SHA-256. When given, S3 enforces it on upload.',
    },
  },
} as const;

export const createUploadResponse = {
  type: 'object',
  properties: {
    fileId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['PENDING'] },
    upload: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['PUT'] },
        url: { type: 'string', description: 'Presigned URL. Upload directly to storage.' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Headers that must be sent verbatim with the PUT, or it will be refused.',
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
      required: ['method', 'url', 'headers', 'expiresAt'],
    },
  },
  required: ['fileId', 'status', 'upload'],
} as const;

export const fileMetadataResponse = {
  type: 'object',
  properties: {
    fileId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['READY'] },
    purpose: { type: 'string', enum: PURPOSES },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer' },
    checksumSha256: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'fileId',
    'status',
    'purpose',
    'contentType',
    'sizeBytes',
    'checksumSha256',
    'createdAt',
  ],
} as const;

export const readUrlResponse = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Presigned, short-lived, single-reader.' },
    expiresAt: { type: 'string', format: 'date-time' },
    contentType: { type: 'string' },
  },
  required: ['url', 'expiresAt', 'contentType'],
} as const;
