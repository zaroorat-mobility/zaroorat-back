import type { MapSettingsView, UpdateMapSettingsBody } from '../types/map-settings.types.js';

const ALLOWED_PROVIDERS = ['ola', 'google', 'mappls'];

export class MapSettingsValidator {
  static validateUpdateInput(input: UpdateMapSettingsBody, currentSettings: MapSettingsView): void {
    const { primaryProvider, fallbackProviders } = input;

    if (!ALLOWED_PROVIDERS.includes(primaryProvider)) {
      throw new Error(
        `Invalid primary provider '${primaryProvider}'. Must be one of: ${ALLOWED_PROVIDERS.join(', ')}`,
      );
    }

    if (fallbackProviders && fallbackProviders.length > 0) {
      throw new Error(
        'Multiple active providers or fallback providers are prohibited. Exactly ONE map provider may be active.',
      );
    }

    // Ensure non-primary providers are NOT set to enabled: true
    for (const provider of ALLOWED_PROVIDERS) {
      if (provider !== primaryProvider) {
        const provConfig = input.providers?.[provider as keyof typeof input.providers];
        if (provConfig && 'enabled' in provConfig && provConfig.enabled === true) {
          throw new Error(
            `Cannot enable provider '${provider}'. Exactly ONE map provider ('${primaryProvider}') may be active at any time.`,
          );
        }
      }
    }

    const primaryConfig =
      input.providers?.[primaryProvider as keyof typeof input.providers] ??
      currentSettings.providers[primaryProvider as keyof typeof currentSettings.providers];
    if (primaryConfig && 'enabled' in primaryConfig && primaryConfig.enabled === false) {
      throw new Error(`Active provider '${primaryProvider}' cannot be disabled.`);
    }
  }
}
