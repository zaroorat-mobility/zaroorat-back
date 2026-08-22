import { VEHICLE_DOCUMENT_TYPES } from '@config';
import { errorResponseSchema } from '@modules/auth/schemas/auth.responses';

export const vehicleErrorResponseSchema = errorResponseSchema;
export const noContentResponse = { type: 'null', description: 'No content' } as const;

export const vehicleIdParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export const vehicleDocumentParamSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    documentId: { type: 'string', format: 'uuid' },
  },
  required: ['id', 'documentId'],
} as const;

export const listVehicleTypesQuerySchema = {
  type: 'object',
  properties: {
    cityId: {
      type: 'string',
      format: 'uuid',
      description:
        'Reserved for service-zone scoping. Accepted and ignored until zones are populated.',
    },
  },
} as const;

const vehicleTypeView = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Pass this as vehicleTypeId elsewhere.' },
    code: { type: 'string', description: 'Stable slug, e.g. BIKE, AUTO, CAB_ECONOMY.' },
    name: { type: 'string' },
    icon: { type: ['string', 'null'], description: 'Client-side glyph key.' },
    displayOrder: { type: 'integer' },
    passengerCapacity: { type: ['integer', 'null'] },
    luggageCapacity: { type: ['integer', 'null'] },
    baseFare: { type: ['number', 'null'] },
    perKmRate: { type: ['number', 'null'] },
    perMinuteRate: { type: ['number', 'null'] },
    minimumFare: { type: ['number', 'null'] },
    isActive: { type: 'boolean' },
  },
  required: ['id', 'code', 'name', 'displayOrder', 'isActive'],
} as const;

export const vehicleTypeListResponse = {
  type: 'object',
  properties: { data: { type: 'array', items: vehicleTypeView } },
  required: ['data'],
} as const;

const vehicleDocumentView = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    vehicleId: { type: 'string', format: 'uuid' },
    documentType: { type: 'string', enum: [...VEHICLE_DOCUMENT_TYPES] },
    documentNumber: { type: ['string', 'null'] },
    fileId: { type: ['string', 'null'], format: 'uuid' },
    issuedAt: { type: ['string', 'null'], format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    verificationStatus: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] },
    rejectionReason: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'vehicleId', 'documentType', 'verificationStatus', 'createdAt'],
} as const;

const vehicleView = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    registrationNumber: { type: 'string' },
    registrationState: { type: ['string', 'null'] },
    vehicleTypeId: { type: 'string', format: 'uuid' },
    vehicleType: { ...vehicleTypeView, nullable: true },
    make: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    color: { type: ['string', 'null'] },
    fuelType: { type: ['string', 'null'] },
    manufacturingYear: { type: ['integer', 'null'] },
    seatingCapacity: { type: ['integer', 'null'] },
    currentDriverId: { type: ['string', 'null'], format: 'uuid' },
    verificationStatus: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] },
    rejectionReason: { type: ['string', 'null'] },
    verifiedAt: { type: ['string', 'null'], format: 'date-time' },
    isActive: { type: 'boolean' },
    documents: { type: 'array', items: vehicleDocumentView },
  },
  required: ['id', 'registrationNumber', 'vehicleTypeId', 'verificationStatus', 'isActive'],
} as const;

export const vehicleResponse = {
  type: 'object',
  properties: { data: vehicleView },
  required: ['data'],
} as const;

export const myVehicleResponse = {
  type: 'object',
  properties: { data: { ...vehicleView, nullable: true } },
  required: ['data'],
} as const;

export const vehicleDocumentResponse = {
  type: 'object',
  properties: { data: vehicleDocumentView },
  required: ['data'],
} as const;

export const vehicleDocumentListResponse = {
  type: 'object',
  properties: { data: { type: 'array', items: vehicleDocumentView } },
  required: ['data'],
} as const;

export const vehicleReviewResponse = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        vehicle: vehicleView,
        documents: { type: 'array', items: vehicleDocumentView },
      },
      required: ['vehicle', 'documents'],
    },
  },
  required: ['data'],
} as const;

export const claimVehicleBodySchema = {
  type: 'object',
  properties: {
    registrationNumber: { type: 'string', minLength: 3, maxLength: 20 },
    vehicleTypeId: {
      type: 'string',
      format: 'uuid',
      description: 'An id from GET /api/v1/vehicle-types. Must be an active type.',
    },
    make: { type: 'string', maxLength: 50 },
    model: { type: 'string', maxLength: 50 },
    color: { type: 'string', maxLength: 30 },
    seatingCapacity: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['registrationNumber', 'vehicleTypeId'],
} as const;

export const updateVehicleBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    make: { type: 'string', maxLength: 50 },
    model: { type: 'string', maxLength: 50 },
    color: { type: 'string', maxLength: 30 },
    seatingCapacity: { type: 'integer', minimum: 1, maximum: 20 },
    registrationState: { type: 'string', maxLength: 50 },
    fuelType: { type: 'string', maxLength: 30 },
    manufacturingYear: { type: 'integer', minimum: 1900 },
  },
} as const;

export const submitVehicleDocumentBodySchema = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: [...VEHICLE_DOCUMENT_TYPES] },
    fileId: {
      type: 'string',
      format: 'uuid',
      description: 'A READY file owned by the caller with purpose VEHICLE_DOCUMENT.',
    },
    documentNumber: { type: 'string', maxLength: 60 },
    issuedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['documentType', 'fileId'],
} as const;

export const reviewVehicleBodySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
    rejectionReason: { type: 'string', maxLength: 255 },
  },
  required: ['status'],
} as const;
