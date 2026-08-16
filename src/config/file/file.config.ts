import { jwtConfig } from '../jwt/jwt.config.js';
export type RetentionTrigger =
  | 'REPLACED'
  | 'DRIVER_RELATIONSHIP_ENDED'
  | 'VEHICLE_RETIRED'
  | 'INCIDENT_CLOSED'
  | 'DISPUTE_CLOSED';
export type RetentionAction = 'ARCHIVE' | 'ERASE';
export interface FilePurposePolicy {
  readonly mimeTypes: readonly string[];
  readonly maxBytes: number;
  readonly maxPixels: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly readTtlSeconds: number;
  readonly rejectExifLocation: boolean;
  readonly retention: {
    readonly afterDays: number;
    readonly trigger: RetentionTrigger;
    readonly action: RetentionAction;
  };
}
function bounded(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
const MB = 1024 * 1024;
export const filePurposePolicy = Object.freeze({
  PROFILE_IMAGE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: bounded(process.env.FILE_MAX_PROFILE_IMAGE_BYTES, 5 * MB, 5 * MB),
    maxPixels: { width: 4096, height: 4096 },
    readTtlSeconds: 600,
    rejectExifLocation: true,
    retention: { afterDays: 365, trigger: 'REPLACED', action: 'ERASE' },
  },
  DRIVER_DOCUMENT: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_DRIVER_DOCUMENT_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 5000, height: 5000 },
    readTtlSeconds: 300,
    rejectExifLocation: true,
    retention: { afterDays: 2920, trigger: 'DRIVER_RELATIONSHIP_ENDED', action: 'ARCHIVE' },
  },
  VEHICLE_DOCUMENT: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_VEHICLE_DOCUMENT_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 5000, height: 5000 },
    readTtlSeconds: 300,
    rejectExifLocation: true,
    retention: { afterDays: 2920, trigger: 'VEHICLE_RETIRED', action: 'ARCHIVE' },
  },
  VEHICLE_IMAGE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: bounded(process.env.FILE_MAX_VEHICLE_IMAGE_BYTES, 5 * MB, 5 * MB),
    maxPixels: { width: 6000, height: 6000 },
    readTtlSeconds: 600,
    rejectExifLocation: true,
    retention: { afterDays: 90, trigger: 'VEHICLE_RETIRED', action: 'ERASE' },
  },
  SOS_EVIDENCE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
    maxBytes: bounded(process.env.FILE_MAX_SOS_EVIDENCE_BYTES, 50 * MB, 50 * MB),
    maxPixels: { width: 8000, height: 8000 },
    readTtlSeconds: 120,
    rejectExifLocation: false,
    retention: { afterDays: 3650, trigger: 'INCIDENT_CLOSED', action: 'ARCHIVE' },
  },
  DISPUTE_EVIDENCE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_DISPUTE_EVIDENCE_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 8000, height: 8000 },
    readTtlSeconds: 180,
    rejectExifLocation: false,
    retention: { afterDays: 1825, trigger: 'DISPUTE_CLOSED', action: 'ARCHIVE' },
  },
} as const satisfies Record<string, FilePurposePolicy>);
export type FilePurposeName = keyof typeof filePurposePolicy;
export const CONTENT_TYPE_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
});
export const PURPOSE_KEY_PREFIX: Readonly<Record<FilePurposeName, string>> = Object.freeze({
  PROFILE_IMAGE: 'pi',
  DRIVER_DOCUMENT: 'dd',
  VEHICLE_DOCUMENT: 'vd',
  VEHICLE_IMAGE: 'vi',
  SOS_EVIDENCE: 'se',
  DISPUTE_EVIDENCE: 'de',
});
export const fileConfig = Object.freeze({
  purposes: filePurposePolicy,
  uploadsPerUserPerHour: Number(process.env.FILE_UPLOADS_PER_HOUR ?? 30),
  uploadsPerPurposePerHour: Number(process.env.FILE_UPLOADS_PER_PURPOSE_PER_HOUR ?? 10),
  readUrlsPerUserPerMinute: Number(process.env.FILE_READ_URLS_PER_MINUTE ?? 60),
  maxTotalBytesPerUser: Number(process.env.FILE_QUOTA_USER_BYTES ?? 500 * MB),
  maxTotalBytesPerPurpose: Number(process.env.FILE_QUOTA_PURPOSE_BYTES ?? 200 * MB),
  maxDailyBytesPerUser: Number(process.env.FILE_QUOTA_DAILY_BYTES ?? 200 * MB),
  sweeperCron: process.env.FILE_SWEEPER_CRON ?? '*/15 * * * *',
  sweeperBatchSize: Number(process.env.FILE_SWEEPER_BATCH ?? 500),
  retentionCron: process.env.FILE_RETENTION_CRON ?? '0 3 * * *',
  retentionBatchSize: Number(process.env.FILE_RETENTION_BATCH ?? 200),
  jobMaxAttempts: Number(process.env.FILE_JOB_MAX_ATTEMPTS ?? 5),
});
export type FileConfig = typeof fileConfig;
export function assertReadTtlsWithinAccessToken(): void {
  const longest = Math.max(
    ...Object.values(filePurposePolicy).map((policy) => policy.readTtlSeconds),
  );
  if (longest >= jwtConfig.accessTtlSeconds) {
    throw new Error(
      `FILES read TTL (${longest}s) must be strictly shorter than the access token ` +
        `(${jwtConfig.accessTtlSeconds}s) — R-FILE-16. Lower FILE read TTLs or raise ` +
        `JWT_ACCESS_TTL_SECONDS.`,
    );
  }
}
assertReadTtlsWithinAccessToken();
