export interface DatabaseConfiguration {
  url: string;
  sslMode?: 'disable' | 'require' | 'verify-full';
  applicationName?: string;
}
export function getDatabaseConfiguration(): DatabaseConfiguration {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is missing');
  }
  return {
    url,
    sslMode: (process.env.DB_SSL_MODE as DatabaseConfiguration['sslMode']) || 'disable',
    applicationName: process.env.APP_NAME || 'ZarooratBackend',
  };
}
