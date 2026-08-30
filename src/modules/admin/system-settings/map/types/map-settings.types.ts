export type MapProviderName = 'ola' | 'google' | 'mappls';

export interface MapProviderConfigView {
  enabled: boolean;
  configured: boolean;
  apiKey?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  baseUrl?: string | undefined;
}

export interface MapSettingsView {
  primaryProvider: string;
  fallbackProviders: string[];
  providers: {
    ola: MapProviderConfigView;
    google: MapProviderConfigView;
    mappls: MapProviderConfigView;
  };
  version: number;
}

export interface UpdateMapSettingsBody {
  primaryProvider: MapProviderName;
  fallbackProviders: MapProviderName[];
  expectedVersion?: number | undefined;
  providers?:
    | {
        ola?:
          | {
              enabled?: boolean | undefined;
              apiKey?: string | undefined;
              baseUrl?: string | undefined;
            }
          | undefined;
        google?:
          | {
              enabled?: boolean | undefined;
              apiKey?: string | undefined;
              baseUrl?: string | undefined;
            }
          | undefined;
        mappls?:
          | {
              enabled?: boolean | undefined;
              clientId?: string | undefined;
              clientSecret?: string | undefined;
              baseUrl?: string | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface TestProviderHealthInput {
  providerName: MapProviderName;
  apiKey?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  baseUrl?: string | undefined;
}

export interface TestProviderHealthResult {
  ok: boolean;
  providerName: string;
  message: string;
  responseTimeMs: number;
}
