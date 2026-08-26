import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolvePushProviderName,
  PushProviderNotDeliverableError,
} from '../../../src/modules/notifications/notification.config.js';

/// The counterpart to `sms-provider-selection.test.ts`. The two resolvers sit
/// next to each other and used to disagree: SMS refused to boot a
/// delivery-required environment on a provider that delivers nothing, push
/// logged a warning and carried on. That asymmetry is the defect — not the
/// absence of an FCM client, which is a feature, but the decision to start
/// anyway and drop every message.
describe('push provider selection (H-5)', () => {
  describe('environments that may use a double', () => {
    it('defaults development to mock', () => {
      assert.equal(resolvePushProviderName('development', undefined), 'mock');
    });

    it('defaults test to mock', () => {
      assert.equal(resolvePushProviderName('test', undefined), 'mock');
    });

    it('allows mock explicitly outside production', () => {
      assert.equal(resolvePushProviderName('development', 'mock'), 'mock');
      assert.equal(resolvePushProviderName('test', 'mock'), 'mock');
    });
  });

  describe('environments that must actually deliver', () => {
    for (const environment of ['production', 'staging']) {
      it(`refuses ${environment} on the mock provider, implicitly`, () => {
        assert.throws(
          () => resolvePushProviderName(environment, undefined),
          PushProviderNotDeliverableError,
        );
      });

      it(`refuses ${environment} on the mock provider, explicitly`, () => {
        assert.throws(
          () => resolvePushProviderName(environment, 'mock'),
          PushProviderNotDeliverableError,
        );
      });
    }

    it('names the environment and what to do about it', () => {
      try {
        resolvePushProviderName('production', 'mock');
        assert.fail('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        assert.match(message, /production/);
        assert.match(message, /PUSH_PROVIDER/);
        // The consequence, not just the rule: whoever hits this at 3am should
        // learn why it matters without going to read the source.
        assert.match(message, /dispatch offer/i);
      }
    });
  });

  it('still refuses a provider name that has no implementation', () => {
    // Unchanged behaviour, and deliberately a different error: "fcm" is a
    // configuration mistake in any environment, whereas mock-in-production is a
    // deployment that would have run.
    assert.throws(() => resolvePushProviderName('development', 'fcm'), /not implemented/);
    assert.throws(() => resolvePushProviderName('production', 'fcm'), /not implemented/);
  });
});
