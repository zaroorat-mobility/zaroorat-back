import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';

/** Normalized map capabilities exposed through MapProviderService. */
export const MAP_CAPABILITY = {
  AUTOCOMPLETE: 'autocomplete',
  PLACE_DETAILS: 'place_details',
  GEOCODE: 'geocode',
  REVERSE_GEOCODE: 'reverse_geocode',
  ROUTE: 'route',
  ROUTE_MATRIX: 'route_matrix',
  SNAP_TO_ROAD: 'snap_to_road',
} as const;

export type MapCapability = (typeof MAP_CAPABILITY)[keyof typeof MAP_CAPABILITY];

export const ALL_MAP_CAPABILITIES: readonly MapCapability[] = Object.values(MAP_CAPABILITY);

export const DEFAULT_PROVIDER_CAPABILITIES: Record<MapProviderName, readonly MapCapability[]> = {
  ola: [
    MAP_CAPABILITY.AUTOCOMPLETE,
    MAP_CAPABILITY.GEOCODE,
    MAP_CAPABILITY.REVERSE_GEOCODE,
    MAP_CAPABILITY.ROUTE,
    MAP_CAPABILITY.ROUTE_MATRIX,
  ],
  google: [
    MAP_CAPABILITY.AUTOCOMPLETE,
    MAP_CAPABILITY.GEOCODE,
    MAP_CAPABILITY.REVERSE_GEOCODE,
    MAP_CAPABILITY.ROUTE,
    MAP_CAPABILITY.ROUTE_MATRIX,
    MAP_CAPABILITY.SNAP_TO_ROAD,
  ],
  mappls: [
    MAP_CAPABILITY.AUTOCOMPLETE,
    MAP_CAPABILITY.GEOCODE,
    MAP_CAPABILITY.REVERSE_GEOCODE,
    MAP_CAPABILITY.ROUTE,
    MAP_CAPABILITY.ROUTE_MATRIX,
    MAP_CAPABILITY.SNAP_TO_ROAD,
  ],
};

export interface MapProviderAttribution {
  /** Visible attribution string required when displaying provider-derived content. */
  text: string;
  /** Provider logo URL when applicable. */
  logoUrl?: string;
}

export interface MapResultMeta {
  provider: MapProviderName;
  configVersion: number;
  capability: MapCapability;
  /** ISO timestamp when this result was generated. */
  generatedAt: string;
  /** ISO timestamp after which clients should refresh this result. */
  expiresAt?: string;
  /** Whether this result came from a fallback provider rather than the pinned primary. */
  usedFallback: boolean;
  attribution: MapProviderAttribution;
  provenance: string;
}

export interface MapPolicySettings {
  primaryProvider: MapProviderName;
  enabledProviders: MapProviderName[];
  fallbackEnabled: boolean;
  /** Ordered fallback providers per capability; empty means no fallback for that capability. */
  fallbackByCapability: Partial<Record<MapCapability, MapProviderName[]>>;
  configVersion: number;
}

export const DEFAULT_MAP_POLICY: MapPolicySettings = {
  primaryProvider: 'ola',
  enabledProviders: ['ola'],
  fallbackEnabled: false,
  fallbackByCapability: {},
  configVersion: 0,
};
