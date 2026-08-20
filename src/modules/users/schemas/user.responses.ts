import type { TokenPair } from '@modules/auth/services/token';
import { errorResponseSchema } from '@modules/auth/schemas/auth.responses';
import { userConfig } from '../config';
export type { DeactivationReason } from '../services/account';
export interface UserProfileView {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  profileImageFileId: string | null;
  languageCode: string | null;
  referralCode: string | null;
}
export interface UserAccountView {
  id: string;
  phoneNumber: string;
  email: string | null;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  status: string;
  roles: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
  profile: UserProfileView;
}
export interface EmergencyContactView {
  id: string;
  contactName: string;
  phoneNumber: string;
  relationship: string | null;
  priority: number;
  createdAt: Date;
}
export interface SavedPlaceView {
  id: string;
  label: string;
  address: string | null;
  buildingName: string | null;
  landmark: string | null;
  floor: string | null;
  instructions: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
}
export interface DeletionRequestResult {
  scheduledFor: string;
}
export interface PhoneChangeChallenge {
  challengeId: string;
  expiresInSec: number;
  resendAvailableInSec: number;
}
export interface PhoneChangeResult extends TokenPair {
  user: {
    id: string;
    phoneNumber: string;
    status: string;
  };
}
export const userErrorResponseSchema = errorResponseSchema;
export const noContentResponse = { type: 'null', description: 'No content' } as const;
export const itemIdParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Item UUID' } },
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
const profileViewProperties = {
  firstName: { type: ['string', 'null'] },
  lastName: { type: ['string', 'null'] },
  dateOfBirth: { type: ['string', 'null'], description: 'Calendar date, YYYY-MM-DD' },
  gender: { type: ['string', 'null'], enum: [...userConfig.genderValues, null] },
  profileImageFileId: { type: ['string', 'null'], format: 'uuid' },
  languageCode: { type: ['string', 'null'] },
  referralCode: { type: ['string', 'null'] },
} as const;
export const profileResponse = {
  type: 'object',
  properties: profileViewProperties,
  required: Object.keys(profileViewProperties),
} as const;
export const accountResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    phoneNumber: { type: 'string' },
    email: { type: ['string', 'null'] },
    isPhoneVerified: { type: 'boolean' },
    isEmailVerified: { type: 'boolean' },
    status: { type: 'string', enum: ['UNVERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] },
    roles: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
    profile: profileResponse,
  },
  required: [
    'id',
    'phoneNumber',
    'email',
    'isPhoneVerified',
    'isEmailVerified',
    'status',
    'roles',
    'createdAt',
    'lastLoginAt',
    'profile',
  ],
} as const;
export const updateProfileBodySchema = {
  type: 'object',
  properties: {
    firstName: { type: ['string', 'null'], maxLength: 64 },
    lastName: { type: ['string', 'null'], maxLength: 64 },
    dateOfBirth: {
      type: ['string', 'null'],
      description: `Calendar date YYYY-MM-DD, in the past, at least ${userConfig.minimumAgeYears} years ago`,
    },
    gender: { type: ['string', 'null'], enum: [...userConfig.genderValues, null] },
    profileImageFileId: {
      type: ['string', 'null'],
      description: 'File id of an uploaded avatar; must be owned by the caller',
    },
    languageCode: {
      type: ['string', 'null'],
      enum: [...userConfig.supportedLanguageCodes, null],
    },
  },
} as const;
export const phoneChangeBodySchema = {
  type: 'object',
  properties: {
    newPhoneNumber: { type: 'string', description: 'E.164 phone number, required' },
  },
} as const;
export const phoneChangeChallengeResponse = {
  type: 'object',
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    expiresInSec: { type: 'integer' },
    resendAvailableInSec: { type: 'integer' },
  },
  required: ['challengeId', 'expiresInSec', 'resendAvailableInSec'],
} as const;
export const phoneVerifyBodySchema = {
  type: 'object',
  properties: {
    challengeId: { type: 'string', description: 'Challenge id from /me/phone/change, required' },
    code: { type: 'string', description: '6-digit OTP code, required' },
  },
} as const;
export const phoneChangeResultResponse = {
  type: 'object',
  properties: {
    accessToken: { type: 'string' },
    accessTokenExpiresInSec: { type: 'integer' },
    refreshToken: { type: 'string' },
    refreshTokenExpiresInSec: { type: 'integer' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        phoneNumber: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'phoneNumber', 'status'],
    },
  },
  required: [
    'accessToken',
    'accessTokenExpiresInSec',
    'refreshToken',
    'refreshTokenExpiresInSec',
    'user',
  ],
} as const;
const contactProperties = {
  id: { type: 'string', format: 'uuid' },
  contactName: { type: 'string' },
  phoneNumber: { type: 'string' },
  relationship: { type: ['string', 'null'] },
  priority: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
} as const;
export const contactResponse = {
  type: 'object',
  properties: contactProperties,
  required: Object.keys(contactProperties),
} as const;
export const contactListResponse = { type: 'array', items: contactResponse } as const;
export const createContactBodySchema = {
  type: 'object',
  properties: {
    contactName: { type: 'string', maxLength: 64, description: 'Required' },
    phoneNumber: { type: 'string', description: 'E.164 phone number, required' },
    relationship: { type: ['string', 'null'], maxLength: 32 },
    priority: { type: 'integer', minimum: 1 },
  },
} as const;
export const updateContactBodySchema = {
  type: 'object',
  properties: createContactBodySchema.properties,
} as const;
const placeProperties = {
  id: { type: 'string', format: 'uuid' },
  label: { type: 'string' },
  address: { type: ['string', 'null'] },
  buildingName: { type: ['string', 'null'] },
  landmark: { type: ['string', 'null'] },
  floor: { type: ['string', 'null'] },
  instructions: { type: ['string', 'null'] },
  latitude: { type: ['number', 'null'] },
  longitude: { type: ['number', 'null'] },
  createdAt: { type: 'string', format: 'date-time' },
} as const;
export const placeResponse = {
  type: 'object',
  properties: placeProperties,
  required: Object.keys(placeProperties),
} as const;
export const placeListResponse = { type: 'array', items: placeResponse } as const;
export const createPlaceBodySchema = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 32, description: 'Required; unique per user' },
    address: { type: ['string', 'null'], maxLength: 255 },
    buildingName: { type: ['string', 'null'], maxLength: 120 },
    landmark: { type: ['string', 'null'], maxLength: 120 },
    floor: { type: ['string', 'null'], maxLength: 32 },
    instructions: { type: ['string', 'null'], maxLength: 280 },
    latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
    longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
  },
} as const;
export const updatePlaceBodySchema = {
  type: 'object',
  properties: createPlaceBodySchema.properties,
} as const;
export const deactivateBodySchema = {
  type: ['object', 'null'],
  properties: {
    reason: {
      type: 'string',
      description:
        'Coarse reason, recorded in the audit event. Never free text. One of: ' +
        userConfig.deactivationReasons.join(', ') +
        '. Enforced by the controller, which reports a rejection as ' +
        '{ field: "reason", code: "NOT_ALLOWED" }.',
    },
  },
} as const;
export const deletionRequestResponse = {
  type: 'object',
  properties: {
    scheduledFor: {
      type: 'string',
      format: 'date-time',
      description: `Erasure date, ${userConfig.deletionRetentionDays} days out. Fixed when the request is accepted.`,
    },
  },
  required: ['scheduledFor'],
} as const;
