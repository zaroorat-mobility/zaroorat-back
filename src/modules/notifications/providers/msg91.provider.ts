import { logger } from '@shared/logger/index.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './sms.provider';

/** MSG91 credentials (from the secret store; never committed). */
export interface Msg91Config {
  authKey: string;
  /** Registered DLT sender/header, when the flow requires it. */
  senderId?: string;
}

/** Subset of the MSG91 flow-API response we consume. */
interface Msg91FlowResponse {
  type?: string;
  request_id?: string;
  message?: string;
}

/**
 * MSG91 SMS adapter using the v5 **flow** API.
 *
 * Indian transactional SMS is DLT-regulated, so sends are template-based: the
 * `templateId` selects a pre-approved template and `variables` fill its slots.
 * The message body is not sent to the gateway (the template owns the text) — it
 * exists only for the generic/mock path. Secrets and OTP variables are never
 * logged (R-AUTH-18): only destination, status, and error are recorded.
 */
export class Msg91Provider implements SmsProvider {
  readonly name = 'msg91';
  private static readonly FLOW_URL = 'https://control.msg91.com/api/v5/flow/';

  /** @param config MSG91 auth key and optional sender id. */
  constructor(private readonly config: Msg91Config) {}

  /**
   * Deliver an SMS via the MSG91 flow API.
   * @param message Must carry a `templateId`; `variables` fill the template.
   * @returns Accepted result with the MSG91 `request_id`, or a failure result.
   */
  async sendSms(message: SmsMessage): Promise<SmsSendResult> {
    if (!message.templateId) {
      return {
        accepted: false,
        provider: this.name,
        error: 'templateId is required for MSG91 (template-based delivery)',
      };
    }

    const recipient: Record<string, string> = {
      mobiles: this.normalize(message.to),
      ...(message.variables ?? {}),
    };

    try {
      const res = await fetch(Msg91Provider.FLOW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: this.config.authKey },
        body: JSON.stringify({
          template_id: message.templateId,
          ...(this.config.senderId ? { sender: this.config.senderId } : {}),
          recipients: [recipient],
        }),
      });

      const raw: unknown = await res.json().catch(() => null);
      const payload = raw as Msg91FlowResponse | null;

      if (!res.ok || payload?.type === 'error') {
        const error = payload?.message ?? `HTTP ${res.status}`;
        logger.error({ to: message.to, status: res.status, error }, '[MSG91] send failed');
        return { accepted: false, provider: this.name, error };
      }

      return {
        accepted: true,
        provider: this.name,
        ...(payload?.request_id ? { providerRef: payload.request_id } : {}),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown transport error';
      logger.error({ to: message.to, error }, '[MSG91] request error');
      return { accepted: false, provider: this.name, error };
    }
  }

  /** MSG91 expects the number without a leading `+`. */
  private normalize(phone: string): string {
    return phone.replace(/^\+/, '');
  }
}
