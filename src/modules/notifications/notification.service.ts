import type { SmsProvider, SmsSendResult } from './providers/sms.provider';
import type { PushProvider, PushSendResult } from './providers/push.provider';
import type { NotificationConfig } from './notification.config';
export interface SendSmsOptions {
  templateId?: string;
  variables?: Record<string, string>;
}
export class NotificationService {
  constructor(
    private readonly smsProvider: SmsProvider,
    private readonly pushProvider: PushProvider,
    private readonly notificationConfig: NotificationConfig,
  ) {}
  async sendPush(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushSendResult> {
    return this.pushProvider.sendPush({ to: fcmToken, title, body, ...(data ? { data } : {}) });
  }
  async sendSms(to: string, body: string, options?: SendSmsOptions): Promise<SmsSendResult> {
    return this.smsProvider.sendSms({
      to,
      body,
      ...(options?.templateId ? { templateId: options.templateId } : {}),
      ...(options?.variables ? { variables: options.variables } : {}),
    });
  }
  async sendOtp(to: string, code: string): Promise<SmsSendResult> {
    const body = `Zaroorat: ${code} is your verification code. Do not share it with anyone.`;
    return this.smsProvider.sendSms({
      to,
      body,
      variables: { otp: code },
      ...(this.notificationConfig.otpTemplateId
        ? { templateId: this.notificationConfig.otpTemplateId }
        : {}),
    });
  }
}
