import type { SmsProvider, SmsSendResult } from './providers/sms.provider';
import type { NotificationConfig } from './notification.config';

/** Optional delivery hints for a generic SMS send. */
export interface SendSmsOptions {
  templateId?: string;
  variables?: Record<string, string>;
}

/**
 * Application-facing notification API.
 *
 * Other modules (e.g. the OTP service in Phase 6) call this and never touch a
 * gateway directly — "OtpService must use NotificationService, never call MSG91
 * directly." It owns templating/formatting and delegates delivery to the injected
 * {@link SmsProvider}. Push and push→SMS fallback are out of scope for this phase.
 */
export class NotificationService {
  /**
   * @param smsProvider The configured SMS gateway (mock or MSG91).
   * @param notificationConfig Resolved config (supplies the OTP template id).
   */
  constructor(
    private readonly smsProvider: SmsProvider,
    private readonly notificationConfig: NotificationConfig,
  ) {}

  /**
   * Send a generic SMS.
   * @param to Destination in E.164 form.
   * @param body Rendered message text.
   * @param options Optional gateway template id and variables.
   * @returns The delivery outcome.
   */
  async sendSms(to: string, body: string, options?: SendSmsOptions): Promise<SmsSendResult> {
    return this.smsProvider.sendSms({
      to,
      body,
      ...(options?.templateId ? { templateId: options.templateId } : {}),
      ...(options?.variables ? { variables: options.variables } : {}),
    });
  }

  /**
   * Deliver a one-time passcode by SMS.
   *
   * The caller (OTP service) generates the code; this method owns only the
   * message/template. The code is passed to the gateway as the `otp` template
   * variable and is never logged here.
   * @param to Destination in E.164 form.
   * @param code The one-time passcode to deliver.
   * @returns The delivery outcome (feeds the `auth.otp.sent` event).
   */
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
