import { logger } from '@shared/logger/index.js';
import { ProviderHttpError, retryIdempotent } from '../provider-http-error.js';

export interface MapplsConfig {
  /** Static REST / license key from auth.mappls.com/console → Credentials. */
  restApiKey?: string;
  /** OAuth client ID (only used together with clientSecret). */
  clientId?: string;
  clientSecret?: string;
  /** Overrides static routing base URL (route.mappls.com). OAuth uses apis.mappls.com/v2. */
  baseUrl?: string;
  timeoutMs?: number;
}

interface MapplsTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class MapplsClient {
  private static readonly OAUTH_URL = 'https://outpost.mappls.com/api/security/oauth/token';
  private static readonly STATIC_ROUTING_BASE_URL = 'https://route.mappls.com/route/direction';
  private static readonly LEGACY_ROUTING_BASE_URL = 'https://apis.mappls.com/advancedmaps/v1';
  private static readonly OAUTH_ROUTING_BASE_URL = 'https://apis.mappls.com/advancedmaps/v2';
  private static readonly SEARCH_BASE_URL = 'https://search.mappls.com/search/address';

  private readonly staticRoutingBaseUrl: string;
  private accessToken: string | null = null;
  private tokenType = 'bearer';
  private tokenExpiresAt: number = 0;

  constructor(protected readonly config: MapplsConfig) {
    const rawBaseUrl =
      config.baseUrl ?? process.env.MAPPLS_BASE_URL ?? MapplsClient.STATIC_ROUTING_BASE_URL;
    this.staticRoutingBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  }

  protected get staticRoutingBase(): string {
    return this.staticRoutingBaseUrl;
  }

  protected get legacyRoutingBase(): string {
    return MapplsClient.LEGACY_ROUTING_BASE_URL;
  }

  protected get oauthRoutingBase(): string {
    return MapplsClient.OAUTH_ROUTING_BASE_URL;
  }

  protected get searchBase(): string {
    return MapplsClient.SEARCH_BASE_URL;
  }

  protected usesOAuth(): boolean {
    return Boolean(this.config.clientId?.trim() && this.config.clientSecret?.trim());
  }

  protected getStaticRestKey(): string {
    return this.config.restApiKey?.trim() ?? '';
  }

  private async getOAuthToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const clientId = this.config.clientId?.trim();
    const clientSecret = this.config.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      throw new Error('[MAPPLS] OAuth requires clientId and clientSecret');
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await fetch(MapplsClient.OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'zaroorat-backend',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderHttpError(
        'Mappls OAuth',
        response.status,
        `${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }

    const data = (await response.json()) as MapplsTokenResponse;
    this.accessToken = data.access_token;
    this.tokenType = (data.token_type ?? 'bearer').toLowerCase();
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private buildStaticUrl(baseUrl: string, endpoint: string, restKey: string): string {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const separator = cleanEndpoint.includes('?') ? '&' : '?';
    return `${baseUrl.replace(/\/+$/, '')}/${cleanEndpoint}${separator}access_token=${encodeURIComponent(restKey)}`;
  }

  private buildServiceUrl(baseUrl: string, endpoint: string): string {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    return `${baseUrl.replace(/\/+$/, '')}/${cleanEndpoint}`;
  }

  private buildLegacyLicenseUrl(licenseKey: string, endpoint: string): string {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    return `${MapplsClient.LEGACY_ROUTING_BASE_URL}/${encodeURIComponent(licenseKey)}/${cleanEndpoint}`;
  }

  /// GET only, so retried. Note the OAuth token fetch below is deliberately not
  /// retried here: a failure there is almost always a credential problem, and
  /// `getOAuthToken` is called again on the next request anyway.
  private async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    return retryIdempotent(() => this.fetchJsonOnce<T>(url, headers));
  }

  private async fetchJsonOnce<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderHttpError(
        'Mappls',
        response.status,
        `${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }

    return (await response.json()) as T;
  }

  private isAuthFailure(error: unknown): boolean {
    if (error instanceof ProviderHttpError) return error.isAuthFailure;
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('(401)') ||
      message.includes('Invalid Token') ||
      message.includes('Token was not recognised')
    );
  }

  /** Static REST key → access_token query param (route.mappls.com / search). */
  protected async makeStaticRequest<T>(baseUrl: string, endpoint: string): Promise<T> {
    const restKey = this.getStaticRestKey();
    if (!restKey) {
      throw new Error('[MAPPLS] Static REST API key is required');
    }

    const url = this.buildStaticUrl(baseUrl, endpoint, restKey);
    try {
      return await this.fetchJson<T>(url);
    } catch (error) {
      logger.error({ error, endpoint, baseUrl, authMode: 'static' }, '[MAPPLS] API request failed');
      throw error;
    }
  }

  /** Legacy license key embedded in URL path (apis.mappls.com/advancedmaps/v1/{key}/...). */
  protected async makeLegacyLicenseRequest<T>(endpoint: string): Promise<T> {
    const licenseKey = this.getStaticRestKey();
    if (!licenseKey) {
      throw new Error('[MAPPLS] Legacy license key is required');
    }

    const url = this.buildLegacyLicenseUrl(licenseKey, endpoint);
    try {
      return await this.fetchJson<T>(url);
    } catch (error) {
      logger.error({ error, endpoint, authMode: 'legacy-license' }, '[MAPPLS] API request failed');
      throw error;
    }
  }

  /** Try route.mappls.com first, then legacy v1 license-key routing. */
  protected async makeStaticRoutingRequest<T>(endpoint: string): Promise<T> {
    try {
      return await this.makeStaticRequest(this.staticRoutingBase, endpoint);
    } catch (error) {
      if (!this.isAuthFailure(error)) {
        throw error;
      }
      logger.warn('[MAPPLS] Static access_token routing rejected — trying legacy license-key URL');
      return this.makeLegacyLicenseRequest<T>(endpoint);
    }
  }

  /** OAuth client credentials → Authorization Bearer header. */
  protected async makeOAuthRequest<T>(baseUrl: string, endpoint: string): Promise<T> {
    const token = await this.getOAuthToken();
    const url = this.buildServiceUrl(baseUrl, endpoint);
    try {
      return await this.fetchJson<T>(url, {
        Authorization: `${this.tokenType} ${token}`,
      });
    } catch (error) {
      logger.error(
        { error, endpoint, baseUrl, authMode: 'oauth-bearer' },
        '[MAPPLS] API request failed',
      );
      throw error;
    }
  }

  protected async makeAuthenticatedRequest<T>(baseUrl: string, endpoint: string): Promise<T> {
    if (this.usesOAuth()) {
      return this.makeOAuthRequest(baseUrl, endpoint);
    }
    return this.makeStaticRequest(baseUrl, endpoint);
  }
}

export function formatMapplsHealthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('Api Access Denied')) {
    return (
      'Mappls OAuth login succeeded but Routing API access is denied for this project. ' +
      'In auth.mappls.com/console, open your project and enable Routing / Directions API for the OAuth client, then retry. ' +
      'Alternatively, use only a static REST API key (leave OAuth fields empty).'
    );
  }
  if (raw.includes('Invalid Token') || raw.includes('Token was not recognised')) {
    return (
      'Mappls REST API key was rejected. Paste the static REST key from auth.mappls.com/console → Credentials into the REST API key field only (not OAuth Client ID). ' +
      'Do not combine REST key with OAuth Client ID/Secret.'
    );
  }
  return raw;
}
