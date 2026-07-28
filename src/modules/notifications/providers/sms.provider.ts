/** A single SMS to deliver. `body` is the rendered text (used by generic/mock
 *  delivery and never logged in production); `templateId`/`variables` drive
 *  template-based gateways such as MSG91 (DLT-compliant transactional SMS). */
export interface SmsMessage {
  /** Destination in E.164 form (`+91…`). */
  to: string;
  /** Rendered message text. */
  body: string;
  /** Gateway template identifier, when the provider requires one. */
  templateId?: string;
  /** Template variable substitutions (e.g. `{ otp: '482913' }`). */
  variables?: Record<string, string>;
}

/** Outcome of a delivery attempt. Providers never throw on gateway failure —
 *  they return `accepted: false` with an `error` so callers can decide fallback. */
export interface SmsSendResult {
  /** Whether the gateway accepted the message for delivery. */
  accepted: boolean;
  /** The provider that handled the send (for observability). */
  provider: string;
  /** Gateway-assigned reference id, when available (→ `auth.otp.sent` event). */
  providerRef?: string;
  /** Human-readable failure reason when `accepted` is false. */
  error?: string;
}

/**
 * Contract every SMS gateway adapter implements. Application code depends on this
 * abstraction (via `NotificationService`), never on a concrete gateway — so MSG91
 * is swappable for a mock or another provider without touching callers.
 */
export interface SmsProvider {
  /** Stable provider identifier (`mock`, `msg91`). */
  readonly name: string;

  /**
   * Deliver one SMS.
   * @param message The message to send.
   * @returns The delivery outcome; never rejects for a gateway-level failure.
   */
  sendSms(message: SmsMessage): Promise<SmsSendResult>;
}
