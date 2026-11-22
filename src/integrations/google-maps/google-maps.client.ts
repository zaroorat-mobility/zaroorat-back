import { logger } from '@shared/logger/index.js';
import { ProviderHttpError, retryIdempotent } from '../provider-http-error.js';

export interface GoogleMapsConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/// Places API (New) has its own host, and takes the key in a header rather than
/// the query string, so the key never sits in a URL a proxy or log can record.
const PLACES_BASE_URL = 'https://places.googleapis.com/v1';

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
    return this.send<T>(url, { method: 'GET' }, endpoint);
  }

  /// One Places API (New) call. The field mask decides which SKU Google bills,
  /// so each caller names exactly the fields it reads. `label` is what gets
  /// logged on failure — never the path itself, which can carry a place id.
  protected async places<T>(
    path: string,
    init: {
      method: 'GET' | 'POST';
      fieldMask: string;
      label: string;
      body?: unknown;
      params?: Record<string, string>;
    },
  ): Promise<T> {
    const url = new URL(`${PLACES_BASE_URL}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(init.params ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.config.apiKey,
      'X-Goog-FieldMask': init.fieldMask,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.send<T>(
      url,
      {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      init.label,
    );
  }

  private async send<T>(url: URL, init: RequestInit, endpoint: string): Promise<T> {
    try {
      // Retried because every call this client makes is a read (the Places
      // autocomplete POST is a search). A timeout or 5xx used to fail a fare
      // quote outright on the first dropped packet.
      return await retryIdempotent(async () => {
        const response = await fetch(url.toString(), {
          ...init,
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
