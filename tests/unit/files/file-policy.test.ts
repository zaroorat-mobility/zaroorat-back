import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTENT_TYPE_EXTENSION,
  PURPOSE_KEY_PREFIX,
  assertReadTtlsWithinAccessToken,
  fileConfig,
  filePurposePolicy,
  type FilePurposeName,
} from '../../../src/config/file/file.config.js';
import { jwtConfig } from '../../../src/config/jwt/jwt.config.js';

describe('file purpose policy', () => {
  const purposes = Object.keys(filePurposePolicy) as FilePurposeName[];

  it('covers all seven purposes', () => {
    assert.deepEqual(purposes.sort(), [
      'DISPUTE_EVIDENCE',
      'DRIVER_DOCUMENT',
      'PROFILE_IMAGE',
      'PROMO_BANNER',
      'SOS_EVIDENCE',
      'VEHICLE_DOCUMENT',
      'VEHICLE_IMAGE',
    ]);
  });

  it('gives every purpose a non-empty MIME allow-list', () => {
    for (const purpose of purposes) {
      assert.ok(filePurposePolicy[purpose].mimeTypes.length > 0, purpose);
    }
  });

  it('never permits a content-type with no mapped extension', () => {
    for (const purpose of purposes) {
      for (const mime of filePurposePolicy[purpose].mimeTypes) {
        assert.ok(CONTENT_TYPE_EXTENSION[mime], `${purpose} permits unmappable ${mime}`);
      }
    }
  });

  it('never permits a wildcard or an opaque binary type', () => {
    for (const purpose of purposes) {
      for (const mime of filePurposePolicy[purpose].mimeTypes) {
        assert.notEqual(mime, '*/*');
        assert.notEqual(mime, 'application/octet-stream');
      }
    }
  });

  it('accepts image/webp everywhere images are accepted', () => {
    for (const purpose of purposes) {
      const { mimeTypes } = filePurposePolicy[purpose];
      if (mimeTypes.some((mime) => mime.startsWith('image/'))) {
        assert.ok(mimeTypes.includes('image/webp'), purpose);
      }
    }
  });

  it('bounds decoded pixels wherever an image is accepted (R-FILE-35)', () => {
    for (const purpose of purposes) {
      const policy = filePurposePolicy[purpose];
      if (policy.mimeTypes.some((mime) => mime.startsWith('image/'))) {
        assert.ok(policy.maxPixels, `${purpose} accepts images with no pixel ceiling`);
        assert.ok(policy.maxPixels.width > 0 && policy.maxPixels.height > 0, purpose);
      }
    }
  });

  it('gives every purpose a positive byte ceiling', () => {
    for (const purpose of purposes) {
      assert.ok(filePurposePolicy[purpose].maxBytes > 0, purpose);
    }
  });

  it('permits EXIF location only where the metadata is the evidence (FILES-OD-10)', () => {
    const preserved = purposes.filter((purpose) => !filePurposePolicy[purpose].rejectExifLocation);
    assert.deepEqual(preserved.sort(), ['DISPUTE_EVIDENCE', 'SOS_EVIDENCE']);
  });

  it('archives rather than erases every compliance-bearing purpose (R-FILE-21)', () => {
    const archived = purposes.filter(
      (purpose) => filePurposePolicy[purpose].retention.action === 'ARCHIVE',
    );
    assert.deepEqual(archived.sort(), [
      'DISPUTE_EVIDENCE',
      'DRIVER_DOCUMENT',
      'SOS_EVIDENCE',
      'VEHICLE_DOCUMENT',
    ]);
  });

  it('starts only the profile-image and promo-banner clock at something FILES can see (doc 03 §6)', () => {
    assert.equal(filePurposePolicy.PROFILE_IMAGE.retention.trigger, 'REPLACED');
    assert.equal(filePurposePolicy.PROMO_BANNER.retention.trigger, 'REPLACED');
    for (const purpose of purposes.filter(
      (name) => name !== 'PROFILE_IMAGE' && name !== 'PROMO_BANNER',
    )) {
      assert.notEqual(filePurposePolicy[purpose].retention.trigger, 'REPLACED', purpose);
    }
  });

  it('has a distinct key prefix per purpose', () => {
    const prefixes = Object.values(PURPOSE_KEY_PREFIX);
    assert.equal(new Set(prefixes).size, prefixes.length);
    for (const prefix of prefixes) assert.match(prefix, /^[a-z]{2}$/);
  });
});

describe('read TTL vs access-token lifetime (R-FILE-36)', () => {
  it('holds for every purpose as configured', () => {
    for (const purpose of Object.keys(filePurposePolicy) as FilePurposeName[]) {
      const ttl = filePurposePolicy[purpose].readTtlSeconds;
      assert.ok(
        ttl < jwtConfig.accessTtlSeconds,
        `${purpose} read TTL ${ttl}s is not shorter than the access token ${jwtConfig.accessTtlSeconds}s`,
      );
    }
  });

  it('passes the startup assertion', () => {
    assert.doesNotThrow(() => assertReadTtlsWithinAccessToken());
  });

  it('grades TTLs by sensitivity — evidence expires soonest', () => {
    const { PROFILE_IMAGE, DRIVER_DOCUMENT, SOS_EVIDENCE } = filePurposePolicy;
    assert.ok(SOS_EVIDENCE.readTtlSeconds < DRIVER_DOCUMENT.readTtlSeconds);
    assert.ok(DRIVER_DOCUMENT.readTtlSeconds < PROFILE_IMAGE.readTtlSeconds);
  });
});

describe('quotas and rate limits', () => {
  it('bounds bytes as well as requests (R-FILE-30)', () => {
    assert.ok(fileConfig.maxTotalBytesPerUser > 0);
    assert.ok(fileConfig.maxDailyBytesPerUser > 0);
    assert.ok(fileConfig.uploadsPerUserPerHour > 0);
  });

  it('keeps the per-purpose upload limit at or below the overall one', () => {
    assert.ok(fileConfig.uploadsPerPurposePerHour <= fileConfig.uploadsPerUserPerHour);
  });

  it('keeps the per-purpose byte quota at or below the per-user one', () => {
    assert.ok(fileConfig.maxTotalBytesPerPurpose <= fileConfig.maxTotalBytesPerUser);
  });
});
