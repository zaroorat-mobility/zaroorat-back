import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OtpDeliveryJob,
  OtpDeliveryRetryableError,
} from '../../../src/modules/auth/jobs/otp-delivery.job.js';
import type { OtpDeliveryJobData } from '../../../src/jobs/producers/index.js';
import type { SmsSendResult } from '../../../src/modules/notifications/providers/sms.provider.js';
import type { PublishInput } from '../../../src/core/events/types.js';

const PHONE = '+919000000000';

describe('OtpDeliveryJob', () => {
  function makeJob(delivery: SmsSendResult) {
    const recorded: { outcome: string; options: Record<string, unknown> }[] = [];
    const published: PublishInput[] = [];
    const metricNames: string[] = [];

    const metrics = {
      sent: () => metricNames.push('sent'),
      retry: () => metricNames.push('retry'),
      providerFailure: () => metricNames.push('provider_failure'),
      deliveryExhausted: () => metricNames.push('delivery_exhausted'),
    };

    const job = new OtpDeliveryJob(
      { sendOtp: async () => delivery } as never,
      {
        recordDelivery: async (_id: string, outcome: string, options: Record<string, unknown>) => {
          recorded.push({ outcome, options });
          return true;
        },
      } as never,
      metrics as never,
      { publish: async (input: PublishInput) => void published.push(input) } as never,
    );

    return { job, recorded, published, metricNames };
  }

  const data: OtpDeliveryJobData = {
    challengeId: 'challenge-1',
    phoneNumber: PHONE,
    code: '123456',
    purpose: 'LOGIN',
  };

  it('records a successful delivery and emits auth.otp.sent', async () => {
    const { job, recorded, published, metricNames } = makeJob({
      accepted: true,
      provider: 'msg91',
      providerRef: 'req-1',
    });

    const result = await job.run(data);

    assert.deepEqual(result, { delivered: true, provider: 'msg91' });
    assert.equal(recorded[0]?.outcome, 'sent');
    assert.equal(recorded[0]?.options.providerRef, 'req-1');
    assert.equal(published[0]?.type, 'auth.otp.sent');
    assert.ok(metricNames.includes('sent'));
  });

  it('throws on a retryable failure so BullMQ schedules another attempt', async () => {
    const { job, recorded, metricNames } = makeJob({
      accepted: false,
      provider: 'msg91',
      retryable: true,
      error: 'HTTP 503',
    });

    await assert.rejects(() => job.run(data), OtpDeliveryRetryableError);
    assert.deepEqual(recorded, [], 'the trail must not be settled while retries remain');
    assert.ok(metricNames.includes('retry'));
  });

  it('settles a terminal failure without throwing, since a retry cannot help', async () => {
    const { job, recorded } = makeJob({
      accepted: false,
      provider: 'msg91',
      retryable: false,
      error: 'template rejected',
    });

    const result = await job.run(data);

    assert.deepEqual(result, { delivered: false, provider: 'msg91' });
    assert.equal(recorded[0]?.outcome, 'failed');
    assert.equal(recorded[0]?.options.failureReason, 'template rejected');
  });

  it('never emits the code in the event payload', async () => {
    const { job, published } = makeJob({ accepted: true, provider: 'mock' });
    await job.run(data);

    assert.ok(!JSON.stringify(published).includes('123456'), 'the code reached an event');
  });

  it('marks an exhausted delivery as failed', async () => {
    const { job, recorded, metricNames } = makeJob({ accepted: true, provider: 'mock' });

    await job.markExhausted('challenge-1', 'HTTP 503');

    assert.equal(recorded[0]?.outcome, 'failed');
    assert.match(String(recorded[0]?.options.failureReason), /delivery_exhausted: HTTP 503/);
    assert.ok(metricNames.includes('delivery_exhausted'));
  });
});
