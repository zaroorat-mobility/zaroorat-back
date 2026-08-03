import { jwtConfig } from '../jwt/jwt.config.js';

/**
 * FILES per-purpose policy (files doc 02 §5 — the authoritative table).
 *
 * The values here are the ones doc 02 §5 publishes; that section and this file
 * are the only two places they appear, and doc 08 §3 deliberately does not
 * restate them. A duplicated policy table drifts, and once already did: the read
 * TTLs violated R-FILE-16 in both copies simultaneously.
 *
 * **Policy is code, not environment.** A MIME allow-list is a security control;
 * as an env var it becomes runtime-mutable with no review, no diff, and no test
 * run — and it does not vary between staging and production anyway (doc 08 §8.2).
 * Only `maxBytes` and `readTtlSeconds` are overridable, and only downward.
 */

/** What starts a purpose's retention clock (doc 03 §6). */
export type RetentionTrigger =
  | 'REPLACED'
  | 'DRIVER_RELATIONSHIP_ENDED'
  | 'VEHICLE_RETIRED'
  | 'INCIDENT_CLOSED'
  | 'DISPUTE_CLOSED';

/** What retention finally does to the bytes (R-FILE-21 / R-FILE-23). */
export type RetentionAction = 'ARCHIVE' | 'ERASE';

/** Every rule that depends on a file's purpose. */
export interface FilePurposePolicy {
  /** Permitted content-types. Never empty, and never a wildcard (doc 02 §5). */
  readonly mimeTypes: readonly string[];
  /** Byte ceiling, checked on declaration and again on the stored object. */
  readonly maxBytes: number;
  /**
   * Decoded-pixel ceiling (R-FILE-35). `null` only where nothing is decoded.
   * A byte ceiling does not bound decoded size: a 5 MB PNG can legally expand
   * to 40,000 × 40,000, which is 6.4 GB of RGBA.
   */
  readonly maxPixels: { readonly width: number; readonly height: number } | null;
  /** Signed-read lifetime. Always shorter than the access token (R-FILE-36). */
  readonly readTtlSeconds: number;
  /** Strip EXIF, except where the metadata *is* the evidence (FILES-OD-10). */
  readonly stripExif: boolean;
  /** When the retention clock starts, and what it does when it runs out. */
  readonly retention: {
    readonly afterDays: number;
    readonly trigger: RetentionTrigger;
    readonly action: RetentionAction;
  };
}

/** Parse a bounded positive integer from the environment. */
function bounded(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const MB = 1024 * 1024;

/**
 * The per-purpose policy table (doc 02 §5).
 *
 * `maxBytes` may be lowered per purpose (a staging bucket with a smaller quota
 * is a real case); the ceiling passed to {@link bounded} means the env can only
 * tighten it, never raise it past what the docs publish.
 */
export const filePurposePolicy = Object.freeze({
  PROFILE_IMAGE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: bounded(process.env.FILE_MAX_PROFILE_IMAGE_BYTES, 5 * MB, 5 * MB),
    maxPixels: { width: 4096, height: 4096 },
    readTtlSeconds: 600,
    stripExif: true,
    retention: { afterDays: 365, trigger: 'REPLACED', action: 'ERASE' },
  },
  DRIVER_DOCUMENT: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_DRIVER_DOCUMENT_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 5000, height: 5000 },
    readTtlSeconds: 300,
    stripExif: true,
    retention: { afterDays: 2920, trigger: 'DRIVER_RELATIONSHIP_ENDED', action: 'ARCHIVE' },
  },
  VEHICLE_DOCUMENT: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_VEHICLE_DOCUMENT_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 5000, height: 5000 },
    readTtlSeconds: 300,
    stripExif: true,
    retention: { afterDays: 2920, trigger: 'VEHICLE_RETIRED', action: 'ARCHIVE' },
  },
  VEHICLE_IMAGE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: bounded(process.env.FILE_MAX_VEHICLE_IMAGE_BYTES, 5 * MB, 5 * MB),
    maxPixels: { width: 6000, height: 6000 },
    readTtlSeconds: 600,
    stripExif: true,
    retention: { afterDays: 90, trigger: 'VEHICLE_RETIRED', action: 'ERASE' },
  },
  SOS_EVIDENCE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
    maxBytes: bounded(process.env.FILE_MAX_SOS_EVIDENCE_BYTES, 50 * MB, 50 * MB),
    maxPixels: { width: 8000, height: 8000 },
    readTtlSeconds: 120,
    stripExif: false,
    retention: { afterDays: 3650, trigger: 'INCIDENT_CLOSED', action: 'ARCHIVE' },
  },
  DISPUTE_EVIDENCE: {
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    maxBytes: bounded(process.env.FILE_MAX_DISPUTE_EVIDENCE_BYTES, 10 * MB, 10 * MB),
    maxPixels: { width: 8000, height: 8000 },
    readTtlSeconds: 180,
    stripExif: false,
    retention: { afterDays: 1825, trigger: 'DISPUTE_CLOSED', action: 'ARCHIVE' },
  },
} as const satisfies Record<string, FilePurposePolicy>);

/** The purposes a file may hold — mirrors the `FilePurpose` enum in the schema. */
export type FilePurposeName = keyof typeof filePurposePolicy;

/**
 * Content-type → extension. **One-way and total**: an extension is never
 * validated, only derived from the content-type magic bytes proved (doc 02
 * §5.0). Validating the client's extension is the check an attacker names their
 * file to pass.
 */
export const CONTENT_TYPE_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
});

/** Two-letter storage-key prefix per purpose (doc 03 §5). */
export const PURPOSE_KEY_PREFIX: Readonly<Record<FilePurposeName, string>> = Object.freeze({
  PROFILE_IMAGE: 'pi',
  DRIVER_DOCUMENT: 'dd',
  VEHICLE_DOCUMENT: 'vd',
  VEHICLE_IMAGE: 'vi',
  SOS_EVIDENCE: 'se',
  DISPUTE_EVIDENCE: 'de',
});

/** Non-purpose FILES policy: quotas and request-rate limits (doc 08 §4–§5). */
export const fileConfig = Object.freeze({
  purposes: filePurposePolicy,
  /** Uploads per user per hour, across all purposes (R-FILE-9). */
  uploadsPerUserPerHour: Number(process.env.FILE_UPLOADS_PER_HOUR ?? 30),
  /** Uploads per user per purpose per hour. */
  uploadsPerPurposePerHour: Number(process.env.FILE_UPLOADS_PER_PURPOSE_PER_HOUR ?? 10),
  /** Read-URL mints per user per minute. */
  readUrlsPerUserPerMinute: Number(process.env.FILE_READ_URLS_PER_MINUTE ?? 60),
  /**
   * Cumulative stored bytes per user (R-FILE-30). A rate limit bounds requests,
   * not bytes: thirty 50 MB clips an hour is inside the rate limit and is 1.5 GB.
   */
  maxTotalBytesPerUser: Number(process.env.FILE_QUOTA_USER_BYTES ?? 500 * MB),
  /** Cumulative stored bytes per user per purpose. */
  maxTotalBytesPerPurpose: Number(process.env.FILE_QUOTA_PURPOSE_BYTES ?? 200 * MB),
  /** Bytes a single user may upload in a rolling day. */
  maxDailyBytesPerUser: Number(process.env.FILE_QUOTA_DAILY_BYTES ?? 200 * MB),
  /** Reservations the sweeper reclaims per run (doc 08 §6). */
  sweeperBatchSize: Number(process.env.FILE_SWEEPER_BATCH ?? 500),
  /** Files retention processes per run. */
  retentionBatchSize: Number(process.env.FILE_RETENTION_BATCH ?? 200),
  /**
   * Retention attempts on one file before it is dead-lettered (doc 09 §4.3).
   *
   * The sweeper has no equivalent because its failure mode is "an orphan
   * survives another fifteen minutes" — self-correcting and free. Retention's is
   * "a file that should have been erased was not", which is a compliance
   * finding: it must not fail silently, and it must not retry forever pretending
   * it will eventually work.
   */
  jobMaxAttempts: Number(process.env.FILE_JOB_MAX_ATTEMPTS ?? 5),
});

export type FileConfig = typeof fileConfig;

/**
 * R-FILE-36 — the cross-config assertion.
 *
 * R-FILE-16 requires every signed read URL to expire before the access token
 * that authorized it. That constraint spans two modules' configuration, so
 * nothing local to either can hold it: it was violated the moment the rule was
 * written as prose in one document and a number in another.
 *
 * Fails at **boot**, not per request — a misconfigured deploy should never accept
 * traffic (doc 08 §7). It also fails for whoever lowers `JWT_ACCESS_TTL_SECONDS`
 * in a different module, which is the person who would otherwise never find out.
 *
 * @throws Error when any purpose's read TTL is not strictly shorter than the
 *         access-token lifetime.
 */
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
