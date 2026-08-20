import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import {
  incrementCounter,
  renderMetrics,
  resetMetrics,
  setGauge,
  SAFE_LABELS,
} from '../../../src/core/metrics/registry.js';

beforeEach(() => resetMetrics());

describe('Metrics registry', () => {
  it('renders counters in the Prometheus text format', () => {
    incrementCounter('auth_login_total');
    incrementCounter('auth_login_total');

    const output = renderMetrics();
    assert.match(output, /# TYPE auth_login_total counter/);
    assert.match(output, /^auth_login_total 2$/m);
  });

  it('keeps series with different labels apart', () => {
    incrementCounter('otp_failed_total', { reason: 'wrong_code' });
    incrementCounter('otp_failed_total', { reason: 'wrong_code' });
    incrementCounter('otp_failed_total', { reason: 'locked' });

    const output = renderMetrics();
    assert.match(output, /^otp_failed_total\{reason="wrong_code"\} 2$/m);
    assert.match(output, /^otp_failed_total\{reason="locked"\} 1$/m);
  });

  it('DROPS high-cardinality labels', () => {
    incrementCounter('ride_completed_total', {
      rideId: 'ride_abc',
      driverId: 'driver_xyz',
      userId: 'user_1',
      reason: 'ok',
    });

    const output = renderMetrics();
    assert.doesNotMatch(output, /ride_abc/);
    assert.doesNotMatch(output, /driver_xyz/);
    assert.doesNotMatch(output, /user_1/);
    assert.match(output, /^ride_completed_total\{reason="ok"\} 1$/m);
  });

  it('collapses every high-cardinality call into one series', () => {
    for (let i = 0; i < 500; i += 1) {
      incrementCounter('driver_location_update_total', { driverId: `driver_${i}` });
    }
    const lines = renderMetrics()
      .split('\n')
      .filter((line) => line.startsWith('driver_location_update_total'));
    assert.equal(lines.length, 1, 'must be one series, not 500');
    assert.match(lines[0] as string, /500$/);
  });

  it('sets gauges to an absolute value rather than accumulating', () => {
    setGauge('outbox_pending', 12);
    setGauge('outbox_pending', 3);

    const output = renderMetrics();
    assert.match(output, /# TYPE outbox_pending gauge/);
    assert.match(output, /^outbox_pending 3$/m);
  });

  it('escapes label values so output cannot be broken', () => {
    incrementCounter('http_requests_total', { route: 'a"b\\c' });
    const output = renderMetrics();
    assert.match(output, /route="a\\"b\\\\c"/);
  });

  it('does not admit an id-shaped label into the allow-list', () => {
    for (const label of SAFE_LABELS) {
      assert.doesNotMatch(
        label,
        /(^|_)(id|userId|driverId|rideId)$/i,
        `"${label}" looks unbounded and must not be a Prometheus label`,
      );
    }
  });
});
