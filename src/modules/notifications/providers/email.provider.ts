export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

export interface EmailSendResult {
  accepted: boolean;
  provider: string;
  providerRef?: string;
  error?: string;
  retryable?: boolean;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(message: EmailMessage): Promise<EmailSendResult>;
  testConnection(): Promise<{ ok: boolean; message: string; responseTimeMs: number }>;
}
