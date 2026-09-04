import type { MapCapability } from '@modules/location/types/map-capabilities.types.js';

export type MapProviderName = 'ola' | 'google' | 'mappls';

/** Admin GET view — never includes secret values, only configured flags. */
export interface MapProviderConfigView {
  enabled: boolean;
  configured: boolean;
  baseUrl?: string | undefined;
  capabilities: MapCapability[];
  lastHealthOk?: boolean | undefined;
  lastHealthAt?: string | undefined;
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
              clientSdkKey?: string | undefined;
              baseUrl?: string | undefined;
            }
          | undefined;
        google?:
          | {
              enabled?: boolean | undefined;
              apiKey?: string | undefined;
              clientSdkKey?: string | undefined;
              baseUrl?: string | undefined;
            }
          | undefined;
        mappls?:
          | {
              enabled?: boolean | undefined;
              restApiKey?: string | undefined;
              clientId?: string | undefined;
              clientSecret?: string | undefined;
              clientSdkKey?: string | undefined;
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

/** Secret-free runtime config for mobile and admin clients. */
export interface PublicMapConfigView {
  primaryProvider: MapProviderName;
  configVersion: number;
  capabilities: MapCapability[];
  attribution: { text: string; logoUrl?: string };
  minClientAdapterVersion: string;
  providers: Record<
    MapProviderName,
    {
      enabled: boolean;
      /** Platform-restricted client SDK key only — never the backend REST key. */
      clientSdkKey?: string;
      tileUrl?: string;
      baseUrl?: string;
    }
  >;
}
