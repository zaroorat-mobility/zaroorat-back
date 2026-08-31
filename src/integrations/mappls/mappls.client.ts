import { logger } from '@shared/logger/index.js';

export interface MapplsConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface MapplsTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class MapplsClient {
  private static readonly OAUTH_URL = 'https://outpost.mapmyindia.com/api/security/oauth/token';
  private readonly apiBaseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(protected readonly config: MapplsConfig) {
    const rawBaseUrl =
      config.baseUrl ?? process.env.MAPPLS_BASE_URL ?? 'https://apis.mappls.com/advancedmaps/v1';
    this.apiBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.config.clientId);
    params.append('client_secret', this.config.clientSecret);
    try {
      const response = await fetch(MapplsClient.OAUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        throw new Error(`Failed to generate Mappls token: ${response.statusText}`);
      }
      const data = (await response.json()) as MapplsTokenResponse;
      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      return this.accessToken;
    } catch (error) {
      logger.error({ error }, '[MAPPLS] Failed to fetch access token');
      throw error;
    }
  }

  protected async makeAuthenticatedRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = `${this.apiBaseUrl}/${cleanEndpoint}`;

    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        throw new Error(`Mappls API error (${response.status}): ${response.statusText}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      logger.error({ error, endpoint }, '[MAPPLS] API request failed');
      throw error;
    }
  }
}
