import { PURPOSE_KEY_PREFIX } from '@config/file/file.config.js';
import { STORAGE_KEY_PATTERN } from '@modules/files/utils/storage-key.js';

/// The storage key of an uploaded branding logo, or null.
///
/// The logo setting is free text, and its URL is re-signed for every client
/// that reads app config. So only an object the logo upload flow writes may be
/// signed: a URL on our own bucket's S3 host whose path is a PROMO_BANNER key
/// (the purpose LogoUploadField uploads with). Any other host, or any other
/// purpose's key, such as a driver document, is never signed.
export function brandingLogoKey(rawUrl: string, bucket: string | null): string | null {
  if (!bucket) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !host.startsWith(`${bucket.toLowerCase()}.s3.`) ||
    !host.endsWith('.amazonaws.com')
  ) {
    return null;
  }
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  // STORAGE_KEY_PATTERN is anchored and admits no `..` or extra segments.
  if (!STORAGE_KEY_PATTERN.test(key) || !key.startsWith(`${PURPOSE_KEY_PREFIX.PROMO_BANNER}/`)) {
    return null;
  }
  return key;
}
