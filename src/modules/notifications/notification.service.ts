import type { SmsProvider, SmsSendResult } from './providers/sms.provider';
import type { PushProvider, PushSendResult } from './providers/push.provider';
import type { NotificationConfig } from './notification.config';
export interface SendSmsOptions {
  templateId?: string;
  variables?: Record<string, string>;
}
export interface SendOtpOptions {
  userType?: 'customer' | 'driver' | string | undefined;
  templateId?: string | undefined;
  message?: string | undefined;
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
  /// Sends an SMS to the driver when an admin rejects one of their documents.
  /// Uses AIRTEL_DRIVER_DOC_REJECTED_TEMPLATE_ID / AIRTEL_DRIVER_DOC_REJECTED_MESSAGE.
  /// The registered DLT template body is fixed text — the env var must match it exactly.
  /// Falls back to a detailed plain message (includes docType + reason) when the
  /// template is not configured, e.g. dev / mock environment.
  async sendDriverDocRejectedSms(
    to: string,
    docType: string,
    reason: string,
  ): Promise<SmsSendResult> {
    const templateId = this.notificationConfig.driverDocRejectedTemplateId;
    // When the env var is set it MUST match the registered DLT body exactly.
    // When unset (dev / mock) we send a richer message for debugging.
    const body =
      this.notificationConfig.driverDocRejectedMessage ??
      `Your document ${docType} has been rejected. Reason: ${reason}. Please re-upload in the Zaroorat Partner App.`;
    return this.smsProvider.sendSms({
      to,
      body,
      ...(templateId ? { templateId } : {}),
    });
  }

  /// Sends an SMS to the driver when their profile is verified and activated by an admin.
  /// Uses AIRTEL_DRIVER_ACTIVATED_TEMPLATE_ID / AIRTEL_DRIVER_ACTIVATED_MESSAGE.
  async sendDriverActivatedSms(to: string): Promise<SmsSendResult> {
    const templateId = this.notificationConfig.driverActivatedTemplateId;
    const body =
      this.notificationConfig.driverActivatedMessage ??
      'Congratulations! Your Zaroorat Driver profile is now verified and activated. You can start accepting rides.';
    return this.smsProvider.sendSms({
      to,
      body,
      ...(templateId ? { templateId } : {}),
    });
  }

  async sendOtp(to: string, code: string, options?: SendOtpOptions): Promise<SmsSendResult> {
    const isDriver = options?.userType === 'driver';
    const templateId =
      options?.templateId ||
      (isDriver
        ? (this.notificationConfig.driverOtpTemplateId ?? this.notificationConfig.otpTemplateId)
        : (this.notificationConfig.customerOtpTemplateId ?? this.notificationConfig.otpTemplateId));

    const rawTemplate =
      options?.message ||
      (isDriver
        ? this.notificationConfig.driverOtpMessage
        : this.notificationConfig.customerOtpMessage);

    const body = rawTemplate
      ? rawTemplate.replace(/\{otp\}/g, code).replace(/\{#var#\}/g, code)
      : `Your OTP is ${code}. Do not share it with anyone.`;

    return this.smsProvider.sendSms({
      to,
      body,
      variables: { otp: code },
      ...(templateId ? { templateId } : {}),
    });
  }
}
