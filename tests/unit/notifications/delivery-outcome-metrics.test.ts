import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { PushProvider } from '../../../src/modules/notifications/providers/push.provider.js';
import { deliveryFakes } from './helpers/delivery-fakes.js';

/// Every device attempt is counted by outcome and provider code, so a Firebase or
/// APNs credential failure is visible as a series, not only as log lines — and
/// the `code` label stays bounded whatever the provider returns.

const RESULT_BY_TOKEN: Record<string, { accepted: boolean; error?: string }> = {
  'tok-ok': { accepted: true },
  'tok-dead': { accepted: false, error: 'messaging/registration-token-not-registered' },
  'tok-apns': { accepted: false, error: 'messaging/third-party-auth-error' },
  'tok-novel': { accepted: false, error: 'messaging/some-code-from-the-future' },
};

describe('notification_delivery_outcome', () => {
  beforeEach(() => resetMetrics());

  it('counts sent, failed and retried devices by bounded code and class', async () => {
    const fakes = deliveryFakes({
      notification: {
        id: 'n-1',
        userId: 'u-1',
        title: 't',
        body: 'b',
        eventKey: 'ride.started',
        data: { category: 'TRANSACTIONAL' },
        status: 'QUEUED',
      },
      deliveries: [
        {
          id: 'd-1',
          notificationId: 'n-1',
          channel: 'PUSH',
          deviceId: null,
          status: 'QUEUED',
          attempts: 0,
        },
      ],
      devices: Object.keys(RESULT_BY_TOKEN).map((fcmToken, i) => ({ id: `dev-${i}`, fcmToken })),
    });
    const provider: PushProvider = {
      name: 'scripted',
      async sendPush(message) {
        return { provider: 'fcm', providerRef: 'ref', ...RESULT_BY_TOKEN[message.to]! };
      },
    };
    const job = new NotificationDeliveryJob(
      fakes.notificationRepository as NotificationRepository,
      fakes.deviceRepository as DeviceRepository,
      provider,
    );

    // A retryable device makes the job throw for BullMQ; the counts are the point.
    await assert.rejects(job.run({ notificationId: 'n-1', deliveryId: 'd-1' }), /Transient/);

    const outcomes = snapshotMetrics()
      .filter((s) => s.name === 'notification_delivery_outcome')
      .map((s): Record<string, string | number> => ({ ...s.labels, value: s.value }))
      .sort((a, b) => `${a.result}${a.code}`.localeCompare(`${b.result}${b.code}`));

    assert.deepEqual(outcomes, [
      {
        result: 'failed',
        code: 'messaging/registration-token-not-registered',
        category: 'TRANSACTIONAL',
        value: 1,
      },
      {
        result: 'retry',
        code: 'messaging/third-party-auth-error',
        category: 'TRANSACTIONAL',
        value: 1,
      },
      { result: 'retry', code: 'other', category: 'TRANSACTIONAL', value: 1 },
      { result: 'sent', category: 'TRANSACTIONAL', value: 1 },
    ]);
  });
});
