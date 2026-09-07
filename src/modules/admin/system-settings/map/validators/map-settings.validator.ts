import type { MapSettingsView, UpdateMapSettingsBody } from '../types/map-settings.types.js';

const ALLOWED_PROVIDERS = ['ola', 'google', 'mappls'] as const;

/// Exactly one map provider is active at a time.
///
/// This class also validated a per-capability fallback chain. That validation
/// could never pass: it rejected any chain entry equal to the primary, and
/// rejected any entry that was not enabled — while `resolveEnabledProviders`
/// returned the primary as the only enabled provider. So every possible chain
/// was refused, and the fallback machinery in `MapProviderService` it fed was
/// dead code that read like outage protection. Both are gone; the single-active
/// rule below is the whole policy.
export class MapSettingsValidator {
  static validateUpdateInput(input: UpdateMapSettingsBody, currentSettings: MapSettingsView): void {
    const { primaryProvider } = input;

    if (!ALLOWED_PROVIDERS.includes(primaryProvider)) {
      throw new Error(
        `Invalid primary provider '${primaryProvider}'. Must be one of: ${ALLOWED_PROVIDERS.join(', ')}`,
      );
    }

    for (const provider of ALLOWED_PROVIDERS) {
      const incoming = input.providers?.[provider];
      if (incoming?.enabled === true && provider !== primaryProvider) {
        throw new Error(
          `Only the active provider '${primaryProvider}' may be enabled. Disable '${provider}' or switch primary.`,
        );
      }
    }

    const primaryConfig =
      input.providers?.[primaryProvider] ?? currentSettings.providers[primaryProvider];
    if (primaryConfig && 'enabled' in primaryConfig && primaryConfig.enabled === false) {
      throw new Error(`Active provider '${primaryProvider}' cannot be disabled.`);
    }
  }
}
