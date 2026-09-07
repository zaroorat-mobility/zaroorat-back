import { logger } from '@shared/logger/index.js';
import { ProviderHttpError, retryIdempotent } from '../provider-http-error.js';

export interface GoogleMapsConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class GoogleMapsClient {
  private readonly baseUrl: string;

  constructor(protected readonly config: GoogleMapsConfig) {
    const rawBaseUrl =
      config.baseUrl ?? process.env.GOOGLE_MAPS_BASE_URL ?? 'https://maps.googleapis.com/maps/api';
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
  }

  protected async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/${cleanEndpoint}`);
    url.searchParams.set('key', this.config.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    try {
      // Retried because every call this client makes is a GET read. A timeout or
      // 5xx used to fail a fare quote outright on the first dropped packet.
      return await retryIdempotent(async () => {
        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => response.statusText);
          throw new ProviderHttpError('Google Maps', response.status, text.slice(0, 200));
        }

        return (await response.json()) as T;
      });
    } catch (error) {
      logger.error({ error, endpoint }, '[GoogleMaps] API request failed');
      throw error;
    }
  }
}
