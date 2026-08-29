import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isWithinPeakWindow,
  minutesOfDayIn,
  parseHhMm,
} from '../../../src/modules/pricing/utils/peak-window.js';

/// FR-013. The admin form validated peak hours, the service stored them, the API
/// returned them, and `resolveSurgeMultiplier` read only `multiplier` — so a
/// window configured for the morning peak surged at three in the morning too.
///
/// The evaluator is pure so these need no database and no clock stub, and the
/// timezone cases can be asserted rather than reasoned about.
describe('peak window evaluation (FR-013)', () => {
  describe('parseHhMm', () => {
    it('reads a well-formed time', () => {
      assert.equal(parseHhMm('08:00'), 480);
      assert.equal(parseHhMm('00:00'), 0);
      assert.equal(parseHhMm('23:59'), 1439);
      assert.equal(parseHhMm('8:30'), 510);
    });

    it('rejects anything else rather than guessing', () => {
      // The column is free text, so an operator can put anything in it. A value
      // that cannot be read must not silently become a bound.
      for (const bad of ['', '8am', '24:00', '12:60', 'noon', '08-00', null, undefined]) {
        assert.equal(parseHhMm(bad), null, `expected ${String(bad)} to be rejected`);
      }
    });
  });

  describe('minutesOfDayIn', () => {
    it('reads the clock in the city, not on the server', () => {
      // 03:00 UTC is 08:30 in Kolkata. A server in UTC applying an 08:00-10:00
      // Srinagar peak by its own clock would be five and a half hours out.
      const at = new Date('2026-08-29T03:00:00Z');
      assert.equal(minutesOfDayIn(at, 'UTC'), 180);
      assert.equal(minutesOfDayIn(at, 'Asia/Kolkata'), 510);
    });
  });

  describe('isWithinPeakWindow', () => {
    const at = (iso: string): Date => new Date(iso);

    it('lets a window that is not peak-hour-only always apply', () => {
      // The surge period is already bounded by startsAt/endsAt.
      const window = { isPeakHourOnly: false, peakHourStart: null, peakHourEnd: null };
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T03:00:00Z'), 'Asia/Kolkata'), true);
    });

    it('applies inside the window and not outside it', () => {
      const window = { isPeakHourOnly: true, peakHourStart: '08:00', peakHourEnd: '10:00' };
      // 03:00 UTC = 08:30 Kolkata — inside.
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T03:00:00Z'), 'Asia/Kolkata'), true);
      // 21:30 UTC = 03:00 Kolkata — the case that used to surge anyway.
      assert.equal(isWithinPeakWindow(window, at('2026-08-28T21:30:00Z'), 'Asia/Kolkata'), false);
    });

    it('treats the end bound as exclusive and the start as inclusive', () => {
      const window = { isPeakHourOnly: true, peakHourStart: '08:00', peakHourEnd: '10:00' };
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T08:00:00Z'), 'UTC'), true);
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T10:00:00Z'), 'UTC'), false);
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T09:59:00Z'), 'UTC'), true);
    });

    it('handles a window that crosses midnight', () => {
      // 22:00-02:00 is the late-night peak every operator runs. Treating end <
      // start as an empty range would switch it off entirely.
      const window = { isPeakHourOnly: true, peakHourStart: '22:00', peakHourEnd: '02:00' };
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T23:30:00Z'), 'UTC'), true);
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T01:00:00Z'), 'UTC'), true);
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T12:00:00Z'), 'UTC'), false);
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T02:00:00Z'), 'UTC'), false);
    });

    it('fails closed when the bounds cannot be read', () => {
      // The safe direction: the alternative is surging around the clock because
      // someone typed "8am" into a text column.
      const window = { isPeakHourOnly: true, peakHourStart: '8am', peakHourEnd: '10:00' };
      assert.equal(isWithinPeakWindow(window, at('2026-08-29T09:00:00Z'), 'UTC'), false);

      const missing = { isPeakHourOnly: true, peakHourStart: null, peakHourEnd: null };
      assert.equal(isWithinPeakWindow(missing, at('2026-08-29T09:00:00Z'), 'UTC'), false);
    });
  });
});
