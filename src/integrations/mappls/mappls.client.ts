import { logger } from '@shared/logger/index.js';
export interface MapplsConfig {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}
interface MapplsTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}
export class MapplsClient {
  private static readonly OAUTH_URL = 'https://outpost.mapmyindia.com/api/security/oauth/token';
  private static readonly API_BASE_URL = 'https://apis.mappls.com/advancedmaps/v1';
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  constructor(private readonly config: MapplsConfig) {}
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken; // Return cached token if valid for at least 1 more minute
    }
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.config.clientId);
    params.append('client_secret', this.config.clientSecret);
    try {
      const response = await fetch(MapplsClient.OAUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
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
  /**
   * Helper to make authenticated requests to Mappls API.
   * @param endpoint e.g., 'route_adv/driving/...'
   */
  protected async makeAuthenticatedRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${MapplsClient.API_BASE_URL}/${endpoint}`;

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
