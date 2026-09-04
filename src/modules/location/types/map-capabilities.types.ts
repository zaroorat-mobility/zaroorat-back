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
  attribution: MapProviderAttribution;
  provenance: string;
}

/// Exactly one provider serves every capability.
///
/// There used to be `fallbackEnabled` and `fallbackByCapability` here, driving a
/// candidate chain in `MapProviderService`. It could never run: the admin
/// validator refused to enable any provider other than the primary, and
/// `resolveMapPolicyFromSettings` returned `enabledProviders: [primary]`, so the
/// chain filtered to empty on every path. It read as outage protection that did
/// not exist. If real failover is wanted later, it needs a policy that can
/// enable a second provider — not this.
export interface MapPolicySettings {
  primaryProvider: MapProviderName;
  enabledProviders: MapProviderName[];
  configVersion: number;
}

export const DEFAULT_MAP_POLICY: MapPolicySettings = {
  primaryProvider: 'ola',
  enabledProviders: ['ola'],
  configVersion: 0,
};
