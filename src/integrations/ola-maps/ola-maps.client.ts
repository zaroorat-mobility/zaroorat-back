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
 * Authentication: API keys are passed as the `api_key` query parameter
 * (Ola Maps docs). Bearer Authorization is only for OAuth 2.0 access tokens,
 * not static API keys — using Bearer with an API key causes 401 Unauthorized.
 *
 * Base URL configurable via OLA_MAPS_BASE_URL (defaults to https://api.olamaps.io).
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
    url.searchParams.set('api_key', this.config.apiKey);
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  protected async post<T>(
    endpoint: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/${cleanEndpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('api_key', this.config.apiKey);

    const headers = new Headers();
    const init: RequestInit = { method: 'POST', headers };

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }

    return this.request<T>(url.toString(), init);
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('X-Request-Id', crypto.randomUUID());

    // Redact api_key from logged URLs
    const safeUrl = url.replace(/([?&]api_key=)[^&]*/i, '$1[REDACTED]');

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
      logger.error({ error, url: safeUrl }, '[OlaMaps] API request failed');
      throw error;
    }
  }
}
