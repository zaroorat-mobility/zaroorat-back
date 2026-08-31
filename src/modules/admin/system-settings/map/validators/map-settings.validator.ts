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

    // Reject enabling any non-primary provider — exactly one active at a time
    for (const provider of ALLOWED_PROVIDERS) {
      if (provider !== primaryProvider) {
        const provConfig = input.providers?.[provider];
        if (provConfig && 'enabled' in provConfig && provConfig.enabled === true) {
          throw new Error(
            `Cannot enable provider '${provider}'. Exactly ONE map provider ('${primaryProvider}') may be active at any time.`,
          );
        }
      }
    }

    const primaryConfig =
      input.providers?.[primaryProvider] ?? currentSettings.providers[primaryProvider];
    if (primaryConfig && 'enabled' in primaryConfig && primaryConfig.enabled === false) {
      throw new Error(`Active provider '${primaryProvider}' cannot be disabled.`);
    }
  }
}
