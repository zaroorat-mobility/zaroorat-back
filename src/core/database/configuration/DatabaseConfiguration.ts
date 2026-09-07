import { readFileSync } from 'node:fs';
import { logger } from '@shared/logger/index.js';

export interface DatabaseConfiguration {
  url: string;
  sslMode?: 'disable' | 'require' | 'verify-full';
  /// PEM contents of the provider's CA bundle, when one is needed.
  sslRootCert?: string;
  applicationName?: string;
}

/// Accept the CA either as a path (DB_SSL_ROOT_CERT, the usual container
/// mount) or inline (DB_SSL_CA, for platforms that only give you env vars).
function readRootCert(): string | undefined {
  const inline = process.env.DB_SSL_CA;
  if (inline) return inline.replace(/\n/g, '\n');

  const path = process.env.DB_SSL_ROOT_CERT;
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `DB_SSL_ROOT_CERT points at ${path}, which could not be read: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export function getDatabaseConfiguration(): DatabaseConfiguration {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is missing');
  }

  const sslMode = (process.env.DB_SSL_MODE as DatabaseConfiguration['sslMode']) || 'disable';

  // pg merges the connection string OVER the options object, so an `sslmode` in
  // the URL silently wins and DB_SSL_MODE does nothing. Say so rather than let
  // a production TLS setting be ignored in silence.
  if (/[?&]sslmode=/i.test(url)) {
    logger.warn(
      { sslMode },
      '[DB Config] DATABASE_URL carries its own sslmode; it overrides DB_SSL_MODE. ' +
        'Set TLS in one place only.',
    );
  }

  const sslRootCert = readRootCert();
  return {
    url,
    sslMode,
    ...(sslRootCert !== undefined ? { sslRootCert } : {}),
    applicationName: process.env.APP_NAME || 'ZarooratBackend',
  };
}
