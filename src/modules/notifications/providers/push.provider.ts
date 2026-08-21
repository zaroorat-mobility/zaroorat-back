export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}
export interface PushSendResult {
  accepted: boolean;
  provider: string;
  providerRef?: string;
  error?: string;
}
export interface PushProvider {
  readonly name: string;
  sendPush(message: PushMessage): Promise<PushSendResult>;
}
