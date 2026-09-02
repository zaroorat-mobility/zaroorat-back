import type { MapCapability } from '@modules/location/types/map-capabilities.types.js';
import { DEFAULT_PROVIDER_CAPABILITIES } from '@modules/location/types/map-capabilities.types.js';
import type { MapSettingsView, UpdateMapSettingsBody } from '../types/map-settings.types.js';

const ALLOWED_PROVIDERS = ['ola', 'google', 'mappls'] as const;

export class MapSettingsValidator {
  static validateUpdateInput(input: UpdateMapSettingsBody, currentSettings: MapSettingsView): void {
    const { primaryProvider } = input;

    if (!ALLOWED_PROVIDERS.includes(primaryProvider)) {
      throw new Error(
        `Invalid primary provider '${primaryProvider}'. Must be one of: ${ALLOWED_PROVIDERS.join(', ')}`,
      );
    }

    const enabledAfterUpdate = this.resolveEnabledProviders(input);
    if (!enabledAfterUpdate.includes(primaryProvider)) {
      throw new Error(
        `Primary provider '${primaryProvider}' must be enabled. Enable it before setting as primary.`,
      );
    }

    const primaryConfig =
      input.providers?.[primaryProvider] ?? currentSettings.providers[primaryProvider];
    if (primaryConfig && 'enabled' in primaryConfig && primaryConfig.enabled === false) {
      throw new Error(`Active provider '${primaryProvider}' cannot be disabled.`);
    }

    if (input.fallback?.byCapability) {
      for (const [capability, chain] of Object.entries(input.fallback.byCapability)) {
        if (!chain?.length) continue;
        for (const provider of chain) {
          if (!ALLOWED_PROVIDERS.includes(provider)) {
            throw new Error(
              `Invalid fallback provider '${provider}' for capability '${capability}'.`,
            );
          }
          if (provider === primaryProvider) {
            throw new Error(
              `Fallback chain for '${capability}' must not include the primary provider '${primaryProvider}'.`,
            );
          }
          if (!enabledAfterUpdate.includes(provider)) {
            throw new Error(
              `Fallback provider '${provider}' for '${capability}' must be enabled before use.`,
            );
          }
        }
      }
    }

    this.assertCapabilitySupport(primaryProvider, input.fallback?.byCapability);
  }

  private static resolveEnabledProviders(
    input: UpdateMapSettingsBody,
  ): (typeof ALLOWED_PROVIDERS)[number][] {
    for (const provider of ALLOWED_PROVIDERS) {
      const incoming = input.providers?.[provider];
      if (incoming?.enabled === true && provider !== input.primaryProvider) {
        throw new Error(
          `Only the active provider '${input.primaryProvider}' may be enabled. Disable '${provider}' or switch primary.`,
        );
      }
    }

    return [input.primaryProvider];
  }

  private static assertCapabilitySupport(
    primaryProvider: (typeof ALLOWED_PROVIDERS)[number],
    byCapability?: Partial<Record<MapCapability, string[]>>,
  ): void {
    if (!byCapability) return;
    const primaryCaps = DEFAULT_PROVIDER_CAPABILITIES[primaryProvider];
    for (const capability of Object.keys(byCapability) as MapCapability[]) {
      if (!primaryCaps.includes(capability)) {
        throw new Error(
          `Primary provider '${primaryProvider}' does not support capability '${capability}'.`,
        );
      }
    }
  }
}
