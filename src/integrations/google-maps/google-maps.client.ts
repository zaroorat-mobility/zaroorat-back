import { logger } from '@shared/logger/index.js';

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
      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Google Maps API error (${response.status}): ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ error, endpoint }, '[GoogleMaps] API request failed');
      throw error;
    }
  }
}
