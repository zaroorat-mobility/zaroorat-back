import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { brandingLogoKey } from '../../../src/modules/admin/system-settings/platform/services/branding-logo-key.js';

const BUCKET = 'zaroorat-files';
const HOST = `https://${BUCKET}.s3.ap-south-1.amazonaws.com`;
const LOGO_KEY = 'pb/2026/10/0123456789abcdef0123456789abcdef.png';
const PRESIGN = '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-Signature=abc';

describe('brandingLogoKey — which logo URLs app config may re-sign', () => {
  it('accepts an uploaded logo (PROMO_BANNER key) on our bucket, presigned or not', () => {
    assert.equal(brandingLogoKey(`${HOST}/${LOGO_KEY}${PRESIGN}`, BUCKET), LOGO_KEY);
    assert.equal(brandingLogoKey(`${HOST}/${LOGO_KEY}`, BUCKET), LOGO_KEY);
  });

  it('refuses a key of any other purpose, e.g. a driver document', () => {
    const driverDoc = 'dd/2026/10/0123456789abcdef0123456789abcdef.jpg';
    assert.equal(brandingLogoKey(`${HOST}/${driverDoc}`, BUCKET), null);
    for (const prefix of ['pi', 'vd', 'vi', 'se', 'de']) {
      assert.equal(
        brandingLogoKey(`${HOST}/${prefix}/2026/10/${'a'.repeat(32)}.jpg`, BUCKET),
        null,
      );
    }
  });

  it('refuses a bucket URL embedded in another host (the old unanchored match)', () => {
    const smuggled = `https://evil.example/?u=${HOST}/${LOGO_KEY}`;
    assert.equal(brandingLogoKey(smuggled, BUCKET), null);
    assert.equal(brandingLogoKey(`https://evil.example/amazonaws.com/${LOGO_KEY}`, BUCKET), null);
  });

  it('refuses other buckets and look-alike hosts', () => {
    assert.equal(
      brandingLogoKey(`https://other.s3.ap-south-1.amazonaws.com/${LOGO_KEY}`, BUCKET),
      null,
    );
    assert.equal(
      brandingLogoKey(`https://x${BUCKET}.s3.ap-south-1.amazonaws.com/${LOGO_KEY}`, BUCKET),
      null,
    );
    assert.equal(
      brandingLogoKey(
        `https://${BUCKET}.s3.ap-south-1.amazonaws.com.evil.example/${LOGO_KEY}`,
        BUCKET,
      ),
      null,
    );
  });

  it('refuses traversal, extra segments and malformed input', () => {
    const traversal = `${HOST}/pb/2026/10/../../dd/2026/10/${'a'.repeat(32)}.jpg`;
    const encoded = `${HOST}/pb%2F2026%2F10%2F..%2F..%2Fdd%2F2026%2F10%2F${'a'.repeat(32)}.jpg`;
    assert.equal(brandingLogoKey(traversal, BUCKET), null);
    assert.equal(brandingLogoKey(encoded, BUCKET), null);
    assert.equal(brandingLogoKey(`${HOST}/x/${LOGO_KEY}`, BUCKET), null);
    assert.equal(
      brandingLogoKey(`http://${BUCKET}.s3.ap-south-1.amazonaws.com/${LOGO_KEY}`, BUCKET),
      null,
    );
    assert.equal(brandingLogoKey('not a url', BUCKET), null);
    assert.equal(brandingLogoKey(`${HOST}/%E0%A4%A`, BUCKET), null);
  });

  it('signs nothing when no bucket is configured', () => {
    assert.equal(brandingLogoKey(`${HOST}/${LOGO_KEY}`, null), null);
  });
});
