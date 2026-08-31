import { logger } from '@shared/logger/index.js';

export interface OlaMapsConfig {
  apiKey: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Thin HTTP client for the Ola Maps REST API.
 *
 * Authentication: Bearer <api_key> in the Authorization header.
 * Base URL configurable via OLA_MAPS_BASE_URL (defaults to https://api.olamaps.io).
 *
 * Unlike Mappls, Ola Maps uses a static API key — no OAuth token refresh is
 * required. Every request attaches the key in the Authorization header; the
 * key is also accepted as `api_key` query param, but the header is preferred
 * so the secret does not appear in server access logs.
 */
export class OlaMapsClient {
  private readonly baseUrl: string;

  constructor(protected readonly config: OlaMapsConfig) {
    const rawBaseUrl = config.baseUrl ?? process.env.OLA_MAPS_BASE_URL ?? 'https://api.olamaps.io';
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
  }

  protected async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/${cleanEndpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  protected async post<T>(endpoint: string, body: unknown): Promise<T> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = `${this.baseUrl}/${cleanEndpoint}`;
    return this.request<T>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${this.config.apiKey}`);
    headers.set('X-Request-Id', crypto.randomUUID());

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Ola Maps API error (${response.status}): ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ error, url }, '[OlaMaps] API request failed');
      throw error;
    }
  }
}
