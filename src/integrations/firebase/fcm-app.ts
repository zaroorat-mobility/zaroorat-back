import * as admin from 'firebase-admin';

/// Singleton Firebase Admin app. Created on first call; subsequent calls
/// return the same instance.
///
/// Initialization strategy (in priority order):
/// 1. FIREBASE_SERVICE_ACCOUNT_JSON env var — full service-account JSON blob.
///    Compatible with any deployment (non-GCP, bare-metal, secret managers).
/// 2. Application Default Credentials — automatic on GCP/GKE/Cloud Run when
///    the var is absent. The Firebase SDK picks this up without any extra config.
///
/// Never called in development or test — FcmPushProvider is only instantiated
/// when PUSH_PROVIDER=fcm, which is rejected in those environments by
/// `resolvePushProviderName`.
let _app: admin.app.App | null = null;

export function initFcmApp(): admin.app.App {
  if (_app) return _app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    let parsed: admin.ServiceAccount;
    try {
      parsed = JSON.parse(raw) as admin.ServiceAccount;
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. ' +
          'Paste the full service-account JSON blob from the Firebase console.',
      );
    }
    const credential = admin.credential.cert(parsed);
    _app = admin.apps.length > 0 ? admin.app() : admin.initializeApp({ credential });
  } else {
    // Application Default Credentials path — for GCP-hosted deployments.
    _app = admin.apps.length > 0 ? admin.app() : admin.initializeApp();
  }

  return _app;
}
