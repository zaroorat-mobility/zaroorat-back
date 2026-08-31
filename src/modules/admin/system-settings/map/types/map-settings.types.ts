export type MapProviderName = 'ola' | 'google' | 'mappls';

/** Admin GET view — never includes secret values, only configured flags. */
export interface MapProviderConfigView {
  enabled: boolean;
  configured: boolean;
  baseUrl?: string | undefined;
}

export interface MapSettingsView {
  primaryProvider: string;
  providers: {
    ola: MapProviderConfigView;
    google: MapProviderConfigView;
    mappls: MapProviderConfigView;
  };
  version: number;
}

export interface UpdateMapSettingsBody {
  primaryProvider: MapProviderName;
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
              restApiKey?: string | undefined;
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
  restApiKey?: string | undefined;
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
