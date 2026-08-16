import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveSmsProviderName,
  SmsProviderNotDeliverableError,
} from '../../../src/modules/notifications/notification.config.js';

describe('SMS provider selection (H-5)', () => {
  describe('environments that may use a double', () => {
    it('defaults development to mock', () => {
      assert.equal(resolveSmsProviderName('development', undefined), 'mock');
    });

    it('defaults test to mock', () => {
      assert.equal(resolveSmsProviderName('test', undefined), 'mock');
    });

    it('allows development + mock explicitly', () => {
      assert.equal(resolveSmsProviderName('development', 'mock'), 'mock');
    });

    it('allows test + mock explicitly — the suites depend on it', () => {
      assert.equal(resolveSmsProviderName('test', 'mock'), 'mock');
    });

    it('still allows a real gateway in development', () => {
      assert.equal(resolveSmsProviderName('development', 'msg91'), 'msg91');
    });
  });

  describe('environments where a message must actually be delivered', () => {
    it('rejects production + mock instead of silently delivering nothing', () => {
      assert.throws(
        () => resolveSmsProviderName('production', 'mock'),
        SmsProviderNotDeliverableError,
      );
    });

    it('rejects staging + mock for the same reason', () => {
      assert.throws(
        () => resolveSmsProviderName('staging', 'mock'),
        SmsProviderNotDeliverableError,
      );
    });

    it('allows production + a real provider', () => {
      assert.equal(resolveSmsProviderName('production', 'msg91'), 'msg91');
    });

    it('allows staging + a real provider', () => {
      assert.equal(resolveSmsProviderName('staging', 'msg91'), 'msg91');
    });

    it('defaults production to a real provider rather than falling back', () => {
      assert.equal(resolveSmsProviderName('production', undefined), 'msg91');
    });

    it('names the environment and the provider, so the failure is self-explaining', () => {
      assert.throws(
        () => resolveSmsProviderName('production', 'mock'),
        /"mock" delivers nothing and cannot be used in production/,
      );
    });

    it('does not hardcode one gateway: any non-mock provider is accepted', () => {
      // A second real gateway added tomorrow needs no change to this rule.
      assert.equal(
        resolveSmsProviderName('production', 'some-other-gateway' as never),
        'some-other-gateway',
      );
    });
  });
});
