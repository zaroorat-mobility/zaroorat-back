import { logger } from '@shared/logger/index.js';
import { maskPhone } from '@shared/validation/index.js';
import type {
  SmsMessage,
  SmsProvider,
  SmsSendResult,
} from '../../modules/notifications/providers/sms.provider.js';

export interface AirtelConfig {
  apiKey?: string;
  username?: string;
  password?: string;
  customerId?: string;
  senderId?: string;
  entityId?: string;
  apiUrl?: string;
  timeoutMs: number;
}

interface AirtelSmsResponse {
  statusCode?: number | string;
  status?: string;
  code?: number | string;
  requestId?: string;
  messageId?: string;
  message?: string;
  description?: string;
  accepted?: boolean;
}

function scrubProviderMessage(message: string): string {
  return message.replace(/\d{7,}/g, '[number]').slice(0, 200);
}

function resolveAuthHeader(config: AirtelConfig): string {
  if (config.apiKey && config.apiKey.trim().length > 0) {
    return config.apiKey.trim();
  }
  if (config.username && config.password) {
    const creds = `${config.username.trim()}:${config.password.trim()}`;
    return `Basic ${Buffer.from(creds).toString('base64')}`;
  }
  return '';
}

export class AirtelProvider implements SmsProvider {
  readonly name = 'airtel';
  private static readonly DEFAULT_API_URL = 'https://iqsms.airtel.in/api/v1/send-prepaid-sms';

  constructor(private readonly config: AirtelConfig) {}

  async sendSms(message: SmsMessage): Promise<SmsSendResult> {
    const apiUrl =
      this.config.apiUrl || process.env.AIRTEL_API_URL || AirtelProvider.DEFAULT_API_URL;
    let recipient: string;

    try {
      recipient = this.normalize(message.to);
    } catch (err) {
      const error = scrubProviderMessage(
        err instanceof Error ? err.message : 'invalid phone number',
      );
      logger.error({ recipient: maskPhone(message.to), error }, '[Airtel] invalid phone number');
      return { accepted: false, provider: this.name, retryable: false, error };
    }

    const payload: Record<string, unknown> = {
      ...(this.config.customerId ? { customerId: this.config.customerId } : {}),
      destinationAddress: [recipient],
      ...(message.templateId ? { dltTemplateId: message.templateId } : {}),
      ...(this.config.entityId ? { entityId: this.config.entityId } : {}),
      message: message.body,
      messageType: 'TRANSACTIONAL',
      ...(this.config.senderId ? { sourceAddress: this.config.senderId } : {}),
    };

    const authHeader = resolveAuthHeader(this.config);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    };

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const raw: unknown = await res.json().catch(() => null);
      const data = raw as AirtelSmsResponse | null;

      const isSuccess =
        res.ok &&
        (data?.statusCode === 200 ||
          data?.statusCode === '200' ||
          data?.status === 'SUCCESS' ||
          data?.status === 'OK' ||
          data?.accepted === true ||
          (Boolean(data?.requestId || data?.messageId) && data?.status !== 'FAILED'));

      if (!isSuccess) {
        const rawError = data?.description || data?.message || `HTTP ${res.status}`;
        const error = scrubProviderMessage(rawError);
        const retryable = res.status === 429 || res.status >= 500;
        logger.error(
          {
            recipient: maskPhone(message.to),
            status: res.status,
            retryable,
            error,
            responseData: raw,
          },
          '[Airtel] send failed',
        );
        return { accepted: false, provider: this.name, retryable, error };
      }

      const providerRef = data?.requestId || data?.messageId;
      return {
        accepted: true,
        provider: this.name,
        ...(providerRef ? { providerRef } : {}),
      };
    } catch (err) {
      const error = scrubProviderMessage(
        err instanceof Error ? err.message : 'unknown transport error',
      );
      logger.error({ recipient: maskPhone(message.to), error }, '[Airtel] request error');
      return { accepted: false, provider: this.name, retryable: true, error };
    }
  }

  private normalize(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    let num = digits;
    if (num.length === 12 && num.startsWith('91')) {
      num = num.slice(2);
    } else if (num.length === 11 && num.startsWith('0')) {
      num = num.slice(1);
    }
    if (!/^[6-9]\d{9}$/.test(num)) {
      throw new Error(`Invalid recipient phone number format: ${phone}`);
    }
    return num;
  }
}
