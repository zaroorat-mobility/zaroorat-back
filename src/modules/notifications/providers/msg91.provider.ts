import { logger } from '@shared/logger/index.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './sms.provider';

export interface Msg91Config {
  authKey: string;
  senderId?: string;
}

interface Msg91FlowResponse {
  type?: string;
  request_id?: string;
  message?: string;
}

export class Msg91Provider implements SmsProvider {
  readonly name = 'msg91';
  private static readonly FLOW_URL = 'https://control.msg91.com/api/v5/flow/';

  constructor(private readonly config: Msg91Config) {}

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

  private normalize(phone: string): string {
    return phone.replace(/^\+/, '');
  }
}
