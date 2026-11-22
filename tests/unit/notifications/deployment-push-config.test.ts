import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/// What the deployment manifests hand the notification pipeline.
///
/// Regression: compose.prod.yml passed neither PUSH_PROVIDER nor the Firebase
/// credential, so an APP_ENV=production stack refused every push; the Helm
/// ConfigMap did not set PUSH_PROVIDER either. And nothing may switch the outbox
/// reconciliation on by manifest — `on` is an explicit, reviewed worker setting.

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/// The `x-app-env` anchor block of compose.prod.yml: shared by api and worker.
function composeAppEnv(): string {
  const text = read('compose.prod.yml');
  const start = text.indexOf('x-app-env:');
  const end = text.indexOf('\nservices:', start);
  assert.ok(start >= 0 && end > start, 'compose.prod.yml has an x-app-env block');
  return text.slice(start, end);
}

describe('deployment push configuration', () => {
  it('compose.prod.yml gives api and worker FCM, and requires its credential', () => {
    const env = composeAppEnv();
    assert.match(env, /^\s+PUSH_PROVIDER: fcm\s*$/m);
    assert.match(env, /^\s+FIREBASE_SERVICE_ACCOUNT_JSON: \$\{FIREBASE_SERVICE_ACCOUNT_JSON:\?/m);
    const text = read('compose.prod.yml');
    assert.match(text, /api:[\s\S]*?<<: \*app-env/);
    assert.match(text, /worker:[\s\S]*?<<: \*app-env/);
  });

  it('the Helm ConfigMap values select FCM for staging and production', () => {
    const values = read('infrastructure/helm/values.yaml');
    const env = values.slice(values.indexOf('\nenv:'), values.indexOf('\nexistingSecret:'));
    assert.match(env, /^\s+PUSH_PROVIDER: fcm\s*$/m);
    for (const overlay of ['values-staging.yaml', 'values-production.yaml']) {
      assert.doesNotMatch(
        read(`infrastructure/helm/${overlay}`),
        /PUSH_PROVIDER:\s*(?!fcm)/,
        `${overlay} does not override PUSH_PROVIDER away from fcm`,
      );
    }
  });

  it('no manifest switches the outbox reconciliation on', () => {
    const files = [
      ...readdirSync(root).filter((f) => /^compose\..*\.ya?ml$/.test(f)),
      ...readdirSync(path.join(root, 'infrastructure/helm'))
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => `infrastructure/helm/${f}`),
      ...readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      '.env.example',
    ];
    for (const file of files) {
      assert.doesNotMatch(
        read(file),
        /NOTIFICATION_EVENT_RECONCILIATION_MODE\s*[:=]\s*['"]?on\b/,
        `${file} leaves the mode unset or dry-run`,
      );
    }
  });
});
