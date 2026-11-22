import {
  SystemSettingRepository,
  type UpsertSystemSettingInput,
} from '../repositories/system-setting.repository.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { decryptSecret, encryptSecret, maskSecret } from '@shared/crypto/encryption.util.js';
import { logger } from '@shared/logger/index.js';
import type { SystemSetting } from '../../../../generated/prisma/index.js';

export interface SystemSettingDto {
  id: string;
  key: string;
  value: string | null;
  category: string | null;
  description: string | null;
  isSecret: boolean;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export class SystemSettingService {
  constructor(private readonly systemSettingRepository: SystemSettingRepository) {}

  async getSettingRaw(key: string, tx?: TransactionClient): Promise<SystemSetting | null> {
    return this.systemSettingRepository.findByKey(key, tx);
  }

  /// Decrypt one row, naming the key when it fails.
  ///
  /// `decryptSecret` throws rather than returning `''`, so that a rotated
  /// ENCRYPTION_KEY is not mistaken for "no credential stored". Reading a
  /// category must still survive a single bad row — an admin whose key rotated
  /// needs the settings page to load so they can re-enter the credentials — so
  /// the failure is contained here and logged against the key that caused it,
  /// which is the part the old catch-all could not tell anyone.
  private decryptRow(key: string, value: string): string | null {
    try {
      return decryptSecret(value);
    } catch (err) {
      logger.error(
        { err, settingKey: key },
        '[SystemSettingService] stored secret could not be decrypted — treating as unset',
      );
      return null;
    }
  }

  async getSettingValue(key: string, tx?: TransactionClient): Promise<string | null> {
    const setting = await this.systemSettingRepository.findByKey(key, tx);
    if (!setting || setting.value === null) return null;
    return setting.isSecret ? this.decryptRow(setting.key, setting.value) : setting.value;
  }

  async getCategorySettings(
    category: string,
    tx?: TransactionClient,
  ): Promise<Map<string, { value: string | null; isSecret: boolean; version: number }>> {
    const rows = await this.systemSettingRepository.findByCategory(category, tx);
    const map = new Map<string, { value: string | null; isSecret: boolean; version: number }>();

    for (const row of rows) {
      const val =
        row.value != null && row.isSecret ? this.decryptRow(row.key, row.value) : row.value;
      map.set(row.key, { value: val, isSecret: row.isSecret, version: row.version });
    }

    return map;
  }

  async getCategorySettingsSafeDto(
    category: string,
    tx?: TransactionClient,
  ): Promise<SystemSettingDto[]> {
    const rows = await this.systemSettingRepository.findByCategory(category, tx);
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.isSecret && row.value ? maskSecret(row.value) : row.value,
      category: row.category,
      description: row.description,
      isSecret: row.isSecret,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    }));
  }

  async setSetting(
    input: UpsertSystemSettingInput,
    tx?: TransactionClient,
  ): Promise<SystemSetting> {
    const valueToSave = input.isSecret && input.value ? encryptSecret(input.value) : input.value;

    return this.systemSettingRepository.upsertSetting(
      {
        ...input,
        value: valueToSave,
      },
      tx,
    );
  }
}
