import { decryptSecret } from '@shared/crypto/encryption.util.js';
import type { MapplsConfig } from './mappls.client.js';

/** Prefer the first non-empty credential, decrypting `enc:` values when present. */
export function resolveMapCredential(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = candidate.startsWith('enc:') ? decryptSecret(candidate) : candidate.trim();
    if (resolved.trim()) return resolved.trim();
  }
  return '';
}

/**
 * Build Mappls provider config with REST/license key preferred over OAuth.
 * Legacy installs may store the REST key in client_id with no secret.
 */
export function buildMapplsProviderConfig(input: {
  restApiKey?: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
}): MapplsConfig | null {
  const restApiKey = input.restApiKey?.trim() ?? '';
  const clientId = input.clientId?.trim() ?? '';
  const clientSecret = input.clientSecret?.trim() ?? '';
  const baseUrl = input.baseUrl?.trim();

  const effectiveRestKey = restApiKey || (!clientSecret ? clientId : '');

  if (effectiveRestKey) {
    return { restApiKey: effectiveRestKey, ...(baseUrl ? { baseUrl } : {}) };
  }

  if (clientId && clientSecret) {
    return { clientId, clientSecret, ...(baseUrl ? { baseUrl } : {}) };
  }

  return null;
}

/** License key embedded in Mappls raster tile URLs. */
export function resolveMapplsTileLicenseKey(input: {
  restApiKey?: string;
  clientId?: string;
  clientSecret?: string;
}): string {
  return buildMapplsProviderConfig(input)?.restApiKey?.trim() ?? '';
}
