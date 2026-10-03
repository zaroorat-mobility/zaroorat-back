import type { SmsProvider, SmsSendResult } from './providers/sms.provider';
import type { PushProvider, PushSendResult } from './providers/push.provider';
import type { NotificationConfig } from './notification.config';
export interface SendSmsOptions {
  templateId?: string;
  variables?: Record<string, string>;
}
export class NotificationService {
  /// The push provider is resolved on first use, not injected: OTP (API and
  /// worker) builds this service, and a push misconfiguration — PUSH_PROVIDER
  /// unset in production, an unparseable Firebase credential — must fail push
  /// only, never SMS.
  constructor(
    private readonly smsProvider: SmsProvider,
    private readonly resolvePushProvider: () => PushProvider,
    private readonly notificationConfig: NotificationConfig,
  ) {}
  async sendPush(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushSendResult> {
    return this.resolvePushProvider().sendPush({
      to: fcmToken,
      title,
      body,
      ...(data ? { data } : {}),
    });
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
