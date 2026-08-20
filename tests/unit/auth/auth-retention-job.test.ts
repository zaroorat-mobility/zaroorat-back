import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthRetentionJob } from '../../../src/modules/auth/jobs/auth-retention.job.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-09T04:30:00.000Z');

interface Row {
  expiresAt: Date;
}

function makeJob(
  opts: {
    otpRows?: Row[];
    refreshRows?: Row[];
    otpRetentionDays?: number;
    refreshRetentionDays?: number;
    lockHeld?: boolean;
  } = {},
) {
  const otp = [...(opts.otpRows ?? [])];
  const refresh = [...(opts.refreshRows ?? [])];
  const calls = {
    otpBatches: 0,
    refreshBatches: 0,
    acquires: 0,
    releases: 0,
    cutoffs: [] as Date[],
  };

  const purge = (table: Row[], counter: 'otpBatches' | 'refreshBatches') => {
    return async (before: Date, limit: number): Promise<number> => {
      calls[counter] += 1;
      calls.cutoffs.push(before);
      const doomed = table.filter((row) => row.expiresAt < before).slice(0, limit);
      for (const row of doomed) table.splice(table.indexOf(row), 1);
      return doomed.length;
    };
  };

  const job = new AuthRetentionJob(
    { purgeExpired: purge(otp, 'otpBatches') } as never,
    { purgeExpired: purge(refresh, 'refreshBatches') } as never,
    {
      lock: {
        acquire: async () => {
          calls.acquires += 1;
          return opts.lockHeld ? null : 'token';
        },
        release: async () => {
          calls.releases += 1;
          return true;
        },
      },
    } as never,
    { retentionPurged: () => {} } as never,
    { trailRetentionDays: opts.otpRetentionDays ?? 30 } as never,
    { revokedRetentionDays: opts.refreshRetentionDays ?? 30 } as never,
  );

  return { job, otp, refresh, calls };
}

const aged = (days: number): Row => ({ expiresAt: new Date(NOW.getTime() - days * DAY_MS) });

describe('AuthRetentionJob', () => {
  it('removes rows past the retention window and keeps the rest', async () => {
    const { job, otp, refresh } = makeJob({
      otpRows: [aged(45), aged(31), aged(29), aged(1)],
      refreshRows: [aged(60), aged(2)],
    });

    const result = await job.run(NOW);

    assert.equal(result.ran, true);
    assert.equal(result.otpRowsDeleted, 2, 'the two rows older than 30 days');
    assert.equal(result.refreshTokensDeleted, 1);
    assert.equal(otp.length, 2, 'rows inside the window are retained');
    assert.equal(refresh.length, 1);
  });

  it('keeps a refresh-token hash past its expiry, for theft detection', async () => {
    const { job, refresh } = makeJob({ refreshRows: [aged(5)] });

    await job.run(NOW);
    assert.equal(refresh.length, 1, 'expired five days ago, still within the window');
  });

  it('dates each cutoff back by its own configured window', async () => {
    const { job, calls } = makeJob({
      otpRows: [aged(100)],
      refreshRows: [aged(100)],
      otpRetentionDays: 7,
      refreshRetentionDays: 90,
    });

    await job.run(NOW);

    const [otpCutoff, refreshCutoff] = calls.cutoffs;
    assert.equal(otpCutoff?.getTime(), NOW.getTime() - 7 * DAY_MS);
    assert.equal(refreshCutoff?.getTime(), NOW.getTime() - 90 * DAY_MS);
  });

  it('deletes in batches rather than one statement over the backlog', async () => {
    const { job, otp, calls } = makeJob({
      otpRows: Array.from({ length: 2_500 }, () => aged(40)),
    });

    const result = await job.run(NOW);

    assert.equal(result.otpRowsDeleted, 2_500);
    assert.equal(otp.length, 0);
    assert.equal(calls.otpBatches, 3, '1000 + 1000 + 500 — the short batch ends the loop');
  });

  it('stops after a short batch instead of asking again', async () => {
    const { job, calls } = makeJob({ otpRows: [aged(40)] });
    await job.run(NOW);
    assert.equal(calls.otpBatches, 1);
  });

  it('is a no-op on an empty table', async () => {
    const { job, calls } = makeJob();
    const result = await job.run(NOW);

    assert.equal(result.otpRowsDeleted, 0);
    assert.equal(result.refreshTokensDeleted, 0);
    assert.equal(calls.otpBatches, 1, 'one probe each, then done');
    assert.equal(calls.refreshBatches, 1);
  });

  it('is safe to run repeatedly — a second pass removes nothing', async () => {
    const { job, otp } = makeJob({ otpRows: [aged(40), aged(2)] });

    const first = await job.run(NOW);
    const second = await job.run(NOW);

    assert.equal(first.otpRowsDeleted, 1);
    assert.equal(second.otpRowsDeleted, 0, 'idempotent: deleting a deleted row is a no-op');
    assert.equal(otp.length, 1);
  });

  it('defers to whichever replica holds the lock', async () => {
    const { job, otp, calls } = makeJob({ otpRows: [aged(40)], lockHeld: true });

    const result = await job.run(NOW);

    assert.deepEqual(result, {
      ran: false,
      otpRowsDeleted: 0,
      refreshTokensDeleted: 0,
      moreRemaining: false,
    });
    assert.equal(calls.otpBatches, 0, 'it touched nothing');
    assert.equal(otp.length, 1);
  });

  it('releases the lock even when a purge throws', async () => {
    const { job, calls } = makeJob();
    (job as unknown as { otpRepository: { purgeExpired: () => Promise<number> } }).otpRepository = {
      purgeExpired: async () => {
        throw new Error('database is down');
      },
    };

    await assert.rejects(() => job.run(NOW), /database is down/);
    assert.equal(calls.releases, 1, 'a stuck lock would block every later run');
  });

  it('reports when a backlog outlives its per-run budget', async () => {
    const { job } = makeJob();
    let batches = 0;
    (
      job as unknown as { otpRepository: { purgeExpired: (b: Date, l: number) => Promise<number> } }
    ).otpRepository = {
      purgeExpired: async (_before, limit) => {
        batches += 1;
        return limit;
      },
    };

    const result = await job.run(NOW);

    assert.equal(batches, 200, 'it stopped at the budget rather than looping forever');
    assert.equal(result.otpRowsDeleted, 200_000);
    assert.equal(result.moreRemaining, true, 'so an operator can see it is still catching up');
  });
});
