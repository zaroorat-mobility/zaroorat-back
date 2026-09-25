export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /// Android notification channel to present on. Channel *importance* is set by
  /// the app when it creates the channel; `android.priority` only controls
  /// delivery timing. Both are required for a ride offer to surface as a
  /// heads-up notification, which is why this is carried per-message rather
  /// than fixed in the provider.
  channelId?: string;
  /// Android notification sound name, resolved against the app's resources.
  sound?: string;
  /// How long FCM may keep trying before it drops the message. A dispatch offer
  /// that expires in seconds must not be deliverable for FCM's 4-week default:
  /// a late offer can only ever present something the driver must not act on.
  ttlMs?: number;
  /// The absolute instant the message stops being worth delivering. When set it
  /// is APNs' expiry exactly (APNs takes an instant, not a duration), so an
  /// offer's push expires with the offer instead of `ttlMs` after the send call.
  expiresAt?: Date;
  /// Supersedes an undelivered message carrying the same key, so a newer ride
  /// status replaces an older one in the tray instead of stacking behind it.
  /// Never set for safety notifications — those must never be collapsed.
  collapseKey?: string;
}
/// A provider refused the message because its data payload exceeded the
/// transport's limit. Declared on the provider *contract* rather than inside the
/// FCM implementation because it is a permanent outcome every caller must be able
/// to recognise: retrying cannot shrink a payload, so a delivery that fails this
/// way must not burn its retry budget.
export const PAYLOAD_TOO_LARGE = 'zaroorat/payload-too-large';

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
