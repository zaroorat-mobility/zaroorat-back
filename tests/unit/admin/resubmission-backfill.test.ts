import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSafeTarget,
  classifyResubmissionCandidate,
  databaseEndpoint,
  exitCodeFor,
  parseBackfillArgs,
  planFingerprint,
  type ApplyReport,
  type CandidateDriver,
  type ConnectedTarget,
  type DecisionRow,
} from '../../../src/modules/admin/driver-management/applications/resubmission-backfill.js';

const driver = (overrides: Partial<CandidateDriver> = {}): CandidateDriver => ({
  id: 'drv-1',
  userId: 'usr-1',
  driverCode: 'DRV_TEST',
  verificationStatus: 'REJECTED',
  rejectionReason: 'Retake the licence photo',
  isSuspended: false,
  deletedAt: null,
  userStatus: 'ACTIVE',
  pendingDocuments: [],
  ...overrides,
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, minute));

/// The audit rows as the 2026-10-03 code wrote them.
const resubmission = (
  id: string,
  minute: number,
  instructions: string,
  status = 'REJECTED',
): DecisionRow => ({
  id,
  action: 'UPDATE',
  createdAt: at(minute),
  metadata: {
    before: { verificationStatus: 'PENDING', rejectionReason: null },
    after: {
      verificationStatus: status,
      rejectionReason: instructions,
      decision: 'RESUBMISSION_REQUESTED',
    },
    notes: instructions,
    result: 'SUCCESS',
  },
});
const rejection = (id: string, minute: number): DecisionRow => ({
  id,
  action: 'REJECT',
  createdAt: at(minute),
  metadata: {
    before: { verificationStatus: 'PENDING' },
    after: { verificationStatus: 'REJECTED' },
    result: 'SUCCESS',
  },
});
const approval = (id: string, minute: number): DecisionRow => ({
  id,
  action: 'APPROVE',
  createdAt: at(minute),
  metadata: { after: { verificationStatus: 'VERIFIED' }, result: 'SUCCESS' },
});

describe('resubmission backfill: who qualifies', () => {
  it('qualifies a driver whose latest decision is the resubmission request that left them REJECTED', () => {
    const result = classifyResubmissionCandidate(driver(), [
      resubmission('a1', 1, 'Retake the licence photo'),
    ]);
    assert.equal(result.outcome, 'eligible');
    assert.equal(result.outcome === 'eligible' && result.sourceAuditId, 'a1');
  });

  it('qualifies a final rejection later reopened by a resubmission request, on the latest one', () => {
    const result = classifyResubmissionCandidate(driver(), [
      rejection('r1', 1),
      resubmission('a2', 2, 'Retake the licence photo'),
    ]);
    assert.equal(result.outcome === 'eligible' && result.sourceAuditId, 'a2');
  });

  it('ignores audit rows that are not verification decisions', () => {
    const result = classifyResubmissionCandidate(driver(), [
      resubmission('a1', 1, 'Retake the licence photo'),
      { id: 'm1', action: 'UPDATE', createdAt: at(5), metadata: { after: { status: 'active' } } },
      {
        id: 'b1',
        action: 'UPDATE',
        createdAt: at(6),
        metadata: { after: { backfill: 'X' }, result: 'SUCCESS' },
      },
      { id: 'f1', action: 'REJECT', createdAt: at(7), metadata: { result: 'FAILED' } },
    ]);
    assert.equal(result.outcome === 'eligible' && result.sourceAuditId, 'a1');
  });

  const excluded: Array<[string, CandidateDriver, DecisionRow[], string]> = [
    [
      'a later final rejection',
      driver(),
      [resubmission('a1', 1, 'Retake the licence photo'), rejection('r1', 2)],
      'FINAL_REJECTION',
    ],
    [
      'a plain final rejection',
      driver({ rejectionReason: 'Fraud' }),
      [rejection('r1', 1)],
      'FINAL_REJECTION',
    ],
    [
      'a blocked account',
      driver({ userStatus: 'DEACTIVATED' }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'BLOCKED',
    ],
    [
      'a suspended driver',
      driver({ isSuspended: true }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'SUSPENDED',
    ],
    [
      'a suspended account',
      driver({ userStatus: 'SUSPENDED' }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'SUSPENDED',
    ],
    [
      'a deleted driver',
      driver({ deletedAt: at(0) }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'DELETED',
    ],
    [
      'a driver no longer REJECTED',
      driver({ verificationStatus: 'PENDING' }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'NOT_REJECTED',
    ],
  ];
  for (const [label, candidate, history, reason] of excluded) {
    it(`excludes ${label}`, () => {
      const result = classifyResubmissionCandidate(candidate, history);
      assert.equal(result.outcome, 'excluded');
      assert.equal(result.outcome === 'excluded' && result.reason, reason);
    });
  }

  const review: Array<[string, CandidateDriver, DecisionRow[], string]> = [
    ['no audited decision at all (pre-2026-10-03)', driver(), [], 'NO_DECISION_AUDIT'],
    [
      'different decisions at the same instant',
      driver(),
      [resubmission('a1', 3, 'Retake the licence photo'), rejection('r1', 3)],
      'TIED_LATEST_DECISIONS',
    ],
    [
      'REJECTED although the latest decision is an approval',
      driver(),
      [resubmission('a1', 1, 'Retake the licence photo'), approval('p1', 2)],
      'STATUS_CONTRADICTS_LATEST_DECISION',
    ],
    [
      'a request recorded as PENDING on a REJECTED driver',
      driver(),
      [resubmission('a1', 1, 'Retake the licence photo', 'PENDING')],
      'RESUBMISSION_RECORDED_WITH_OTHER_STATUS',
    ],
    [
      'instructions changed since the request',
      driver({ rejectionReason: 'Something else' }),
      [resubmission('a1', 1, 'Retake the licence photo')],
      'INSTRUCTIONS_CHANGED_SINCE_REQUEST',
    ],
  ];
  for (const [label, candidate, history, reason] of review) {
    it(`sends to manual review: ${label}`, () => {
      const result = classifyResubmissionCandidate(candidate, history);
      assert.equal(result.outcome, 'review');
      assert.equal(result.outcome === 'review' && result.reason, reason);
    });
  }

  it('flags the old default note on an unaudited rejection as a hint, without deciding on it', () => {
    const result = classifyResubmissionCandidate(
      driver({ rejectionReason: 'Resubmission requested' }),
      [],
    );
    assert.equal(result.outcome === 'review' && result.legacyDefaultInstructions, true);
  });
});

describe('resubmission backfill: documents uploaded since the request', () => {
  const sentBack = [resubmission('a1', 10, 'Retake the licence photo')];
  const pending = (source: 'driver' | 'vehicle', minute: number) => ({
    source,
    documentType: source === 'driver' ? 'DRIVING_LICENSE' : 'RC',
    updatedAt: at(minute),
  });

  for (const source of ['driver', 'vehicle'] as const) {
    it(`sends to manual review a driver whose ${source} document was uploaded after the request`, () => {
      const result = classifyResubmissionCandidate(
        driver({ pendingDocuments: [pending(source, 20)] }),
        sentBack,
      );
      assert.equal(result.outcome, 'review');
      assert.equal(
        result.outcome === 'review' && result.reason,
        'DOCUMENTS_UPLOADED_SINCE_REQUEST',
      );
    });
  }

  it('still qualifies a driver whose pending documents all predate the request', () => {
    const result = classifyResubmissionCandidate(
      driver({ pendingDocuments: [pending('driver', 1), pending('vehicle', 2)] }),
      sentBack,
    );
    assert.equal(result.outcome === 'eligible' && result.sourceAuditId, 'a1');
  });

  it('treats an upload within the clock margin before the request as possibly after it', () => {
    const result = classifyResubmissionCandidate(
      driver({ pendingDocuments: [pending('driver', 9)] }),
      sentBack,
    );
    assert.equal(result.outcome === 'review' && result.reason, 'DOCUMENTS_UPLOADED_SINCE_REQUEST');
  });

  it('measures uploads against the latest request, not an earlier one', () => {
    const result = classifyResubmissionCandidate(
      driver({ pendingDocuments: [pending('driver', 20)] }),
      [resubmission('a0', 1, 'Old note'), resubmission('a2', 40, 'Retake the licence photo')],
    );
    assert.equal(result.outcome === 'eligible' && result.sourceAuditId, 'a2');
  });
});

describe('resubmission backfill: the database endpoint', () => {
  it('reads host and port the way the pool connects, query-string overrides included', () => {
    assert.deepEqual(databaseEndpoint('postgresql://u:secret@db.prod.internal:6543/zaroorat'), {
      host: 'db.prod.internal',
      port: 6543,
    });
    assert.deepEqual(databaseEndpoint('postgresql://u:secret@127.0.0.1/zaroorat'), {
      host: '127.0.0.1',
      port: 5432,
    });
    // pg lets ?host= override the authority: the URL says localhost, the pool goes to prod.
    assert.deepEqual(
      databaseEndpoint('postgresql://u:secret@localhost:5432/zaroorat?host=prod.example.com'),
      { host: 'prod.example.com', port: 5432 },
    );
    assert.deepEqual(databaseEndpoint('postgresql://u:secret@[::1]:5432/zaroorat'), {
      host: '::1',
      port: 5432,
    });
  });

  it('refuses a socket connection or an unreadable URL without echoing it', () => {
    for (const url of [
      'postgresql://u:secret@/zaroorat?host=/var/run/postgresql',
      'postgresql://u:secret@host:notaport/zaroorat',
    ]) {
      assert.throws(
        () => databaseEndpoint(url),
        (err: Error) => /Refusing/.test(err.message) && !err.message.includes('secret'),
        url,
      );
    }
  });
});

describe('resubmission backfill: command-line guards', () => {
  const args = (line: string) => parseBackfillArgs(line.split(' ').filter(Boolean));
  const local: ConnectedTarget = {
    environment: 'development',
    database: 'zaroorat',
    host: '127.0.0.1',
    port: 5432,
  };
  const devArgs = '--env development --database zaroorat --host 127.0.0.1:5432';

  it('is a dry run unless --apply is given', () => {
    assert.equal(args(devArgs).apply, false);
    assert.equal(args(`${devArgs} --apply --actor u1`).apply, true);
  });

  it('reports the verified target, host included and credentials never', () => {
    assert.deepEqual(assertSafeTarget(args(devArgs), local), {
      environment: 'development',
      database: 'zaroorat',
      host: '127.0.0.1:5432',
    });
  });

  it('requires --env, --database and --host, each naming exactly what it is connected to', () => {
    for (const line of [
      '',
      '--env development --database zaroorat',
      '--env development --host 127.0.0.1',
      '--database zaroorat --host 127.0.0.1',
      '--env test --database zaroorat --host 127.0.0.1',
      '--env development --database zaroorat_test --host 127.0.0.1',
    ]) {
      assert.throws(() => assertSafeTarget(args(line), local), /Refusing/, line);
    }
  });

  it('tells apart two servers whose databases share a name', () => {
    // Development and production are both called `zaroorat`: the name proves nothing.
    for (const host of ['127.0.0.1:5433', '10.0.0.5:5432', 'localhost:5432']) {
      assert.throws(
        () => assertSafeTarget(args(`--env development --database zaroorat --host ${host}`), local),
        /--host/,
        host,
      );
    }
    assert.throws(
      () =>
        assertSafeTarget(args('--env development --database zaroorat --host 127.0.0.1'), {
          ...local,
          port: 5433,
        }),
      /--host/,
      'an omitted port means 5432',
    );
  });

  it('refuses a production URL loaded under APP_ENV=development, flag or not', () => {
    const strayUrl: ConnectedTarget = {
      environment: 'development',
      database: 'zaroorat',
      ...databaseEndpoint(
        'postgresql://app:secret@zaroorat-prod.abc.rds.amazonaws.com:5432/zaroorat',
      ),
    };
    const host = '--host zaroorat-prod.abc.rds.amazonaws.com:5432';
    for (const line of [
      `--env development --database zaroorat ${host}`,
      `--env development --database zaroorat ${host} --allow-production`,
      `--env production --database zaroorat ${host} --allow-production`,
    ]) {
      assert.throws(() => assertSafeTarget(args(line), strayUrl), /Refusing/, line);
    }
  });

  it('treats production, and any remote server, as production: only --allow-production runs it', () => {
    const tunnel: ConnectedTarget = { ...local, environment: 'production', port: 15432 };
    const prodArgs = '--env production --database zaroorat --host 127.0.0.1:15432';
    assert.throws(() => assertSafeTarget(args(prodArgs), tunnel), /--allow-production/);
    assert.doesNotThrow(() => assertSafeTarget(args(`${prodArgs} --allow-production`), tunnel));

    const staging: ConnectedTarget = {
      environment: 'staging',
      database: 'zaroorat',
      host: 'staging-db.internal',
      port: 5432,
    };
    const stagingArgs = '--env staging --database zaroorat --host staging-db.internal';
    assert.throws(() => assertSafeTarget(args(stagingArgs), staging), /--allow-production/);
    assert.doesNotThrow(() => assertSafeTarget(args(`${stagingArgs} --allow-production`), staging));
  });

  it('refuses malformed, unknown, repeated or valueless arguments', () => {
    for (const line of [
      `${devArgs} --aply`,
      `${devArgs} stray`,
      `${devArgs} --env development`,
      '--env --database zaroorat --host 127.0.0.1',
      `${devArgs} --actor`,
      '--env development --database zaroorat --host db:prod:1',
      '--env development --database zaroorat --host ::1',
      '--env development --database zaroorat --host 127.0.0.1:0',
      '--env development --database zaroorat --host 127.0.0.1:70000',
    ]) {
      assert.throws(() => args(line), /Refusing/, line);
    }
    assert.throws(
      () => parseBackfillArgs([...devArgs.split(' '), 'postgresql://u:secret@h/db']),
      (err: Error) => !err.message.includes('secret'),
      'an unexpected value is not echoed',
    );
    assert.deepEqual(args('--env development --database zaroorat --host [::1]:5432').host, {
      host: '::1',
      port: 5432,
    });
  });

  it('refuses to apply without an operator to attribute the change to', () => {
    assert.throws(
      () => assertSafeTarget(args(`${devArgs} --apply --plan ${'a'.repeat(64)}`), local),
      /--actor/,
    );
  });

  it('refuses to apply without the fingerprint of the reviewed dry run', () => {
    const operator = '--actor 0190f5a0-0000-7000-8000-000000000001';
    assert.throws(() => assertSafeTarget(args(`${devArgs} --apply ${operator}`), local), /--plan/);
    assert.throws(
      () => assertSafeTarget(args(`${devArgs} --apply ${operator} --plan 12ab`), local),
      /--plan/,
    );
    assert.doesNotThrow(() =>
      assertSafeTarget(args(`${devArgs} --apply ${operator} --plan ${'0f'.repeat(32)}`), local),
    );
  });
});

describe('resubmission backfill: the reviewed plan', () => {
  const a = { driverId: 'd-a', sourceAuditId: 'audit-1' };
  const b = { driverId: 'd-b', sourceAuditId: 'audit-2' };

  it('fingerprints the eligible drivers and their source requests, in any order', () => {
    assert.match(planFingerprint([a, b]), /^[0-9a-f]{64}$/);
    assert.equal(planFingerprint([a, b]), planFingerprint([b, a]));
  });

  it('changes when a driver is added, removed, or bound to another request', () => {
    const reviewed = planFingerprint([a, b]);
    for (const changed of [
      [a],
      [a, b, { driverId: 'd-c', sourceAuditId: 'audit-3' }],
      [a, { ...b, sourceAuditId: 'audit-9' }],
      [a, { driverId: 'd-c', sourceAuditId: 'audit-2' }],
      [],
    ]) {
      assert.notEqual(planFingerprint(changed), reviewed, JSON.stringify(changed));
    }
  });
});

describe('resubmission backfill: exit status', () => {
  const row = { driverId: 'd', driverCode: 'DRV' };
  const report = (updated: number, skipped: number, failed: number): ApplyReport => ({
    fingerprint: 'f',
    eligible: updated + skipped + failed,
    updated: Array.from({ length: updated }, () => ({ ...row, sourceAuditId: 'a' })),
    skipped: Array.from({ length: skipped }, () => ({ ...row, why: 'moved' })),
    failed: Array.from({ length: failed }, () => ({ ...row, error: 'P2034' })),
  });

  it('is 0 when nothing failed, 2 for a partial failure and 3 when every driver failed', () => {
    assert.equal(exitCodeFor(report(2, 1, 0)), 0);
    assert.equal(exitCodeFor(report(0, 0, 0)), 0);
    assert.equal(exitCodeFor(report(2, 0, 1)), 2);
    assert.equal(exitCodeFor(report(0, 1, 1)), 2);
    assert.equal(exitCodeFor(report(0, 0, 2)), 3);
  });
});
