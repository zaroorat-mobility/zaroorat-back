export interface SmsMessage {
  to: string;
  body: string;
  templateId?: string;
  variables?: Record<string, string>;
}
export interface SmsSendResult {
  accepted: boolean;
  provider: string;
  providerRef?: string;
  error?: string;
  retryable?: boolean;
}
export interface SmsProvider {
  readonly name: string;
  sendSms(message: SmsMessage): Promise<SmsSendResult>;
}
