function list(value: string | undefined, fallback: string): readonly string[] {
  return Object.freeze(
    (value ?? fallback)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export const userConfig = Object.freeze({
  minimumAgeYears: Number(process.env.USER_MIN_AGE_YEARS ?? 16),
  supportedLanguageCodes: list(process.env.USER_SUPPORTED_LANGUAGES, 'en,hi'),
  genderValues: Object.freeze(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const),
  defaultLanguageCode: 'en',
  maxEmergencyContacts: Number(process.env.USER_MAX_EMERGENCY_CONTACTS ?? 5),
  maxSavedPlaces: Number(process.env.USER_MAX_SAVED_PLACES ?? 20),
  phoneChangeRequestLimit: Number(process.env.USER_PHONE_CHANGE_LIMIT ?? 3),
  phoneChangeWindowSeconds: Number(process.env.USER_PHONE_CHANGE_WINDOW_SEC ?? 86_400),
  deactivationReasons: Object.freeze(['NOT_USING', 'PRIVACY', 'SWITCHING', 'OTHER'] as const),
  deletionRetentionDays: Number(process.env.USER_DELETION_RETENTION_DAYS ?? 30),
  erasureCron: process.env.USER_ERASURE_CRON ?? '30 3 * * *',
  erasureBatchSize: Number(process.env.USER_ERASURE_BATCH ?? 100),
});

export type UserConfig = typeof userConfig;
