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

/// One top-level service block of a compose file.
function composeService(text: string, service: string): string {
  const start = text.indexOf(`\n  ${service}:\n`);
  assert.ok(start >= 0, `compose file has a ${service} service`);
  const next = text.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('deployment push configuration', () => {
  // Since the multi-env standardization the app environment reaches api and worker
  // only through the env file; src/config/env/schema.ts refuses PUSH_PROVIDER=fcm
  // without FIREBASE_SERVICE_ACCOUNT_JSON in a deployed environment.
  it('compose.prod.yml gives api and worker the env file, whose template selects FCM', () => {
    const text = read('compose.prod.yml');
    for (const service of ['api', 'worker']) {
      assert.match(
        composeService(text, service),
        /env_file:\s*\n\s+- \$\{APP_ENV_FILE:-\.env\.prod\}/,
        service,
      );
    }
    for (const env of ['prod', 'staging']) {
      const template = read(`deploy/env/.env.${env}.example`);
      assert.match(template, /^PUSH_PROVIDER=fcm$/m, env);
      assert.match(template, /^FIREBASE_SERVICE_ACCOUNT_JSON=\S/m, env);
    }
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
