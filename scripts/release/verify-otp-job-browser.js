#!/usr/bin/env node
/**
 * Release check: the COMPILED admin job browser (dist/) never exposes an auth-otp job's
 * payload — the plaintext OTP and the phone it is sent to.
 *
 * It enqueues real auth-otp jobs, puts one in each state (waiting, active, delayed,
 * failed, completed) with BullMQ itself, then drives `AdminJobsService` from dist/
 * exactly as the admin routes do: list, detail, retry and remove. Every response and
 * every audit row it would write is searched for the code and the phone.
 *
 * Run it against the artifact being shipped — inside the freshly built image, or after
 * `npm run build` — never against production:
 *
 *   RELEASE_CHECK_REDIS_URL=redis://localhost:6379/9 node scripts/release/verify-otp-job-browser.js
 *
 *   docker run --rm -v "$PWD/scripts/release:/release:ro" \
 *     -e RELEASE_CHECK_REDIS_URL=redis://host.docker.internal:6379/9 \
 *     <image> node /release/verify-otp-job-browser.js
 *
 * Safety: refuses APP_ENV=staging|production, and refuses a queue that has any worker
 * attached — a live OTP worker would send the test job. The phone number is undeliverable
 * (Indian mobiles never start with 0), and only the jobs it created are removed.
 * Exits 0 on PASS, 1 on a leak, 2 if it could not run.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = process.env.APP_ROOT || process.cwd();
const REDIS_URL = process.env.RELEASE_CHECK_REDIS_URL;
const CODE = '739184';
const PHONE = '+910000584721';
const LEAKS = [new RegExp(CODE), /0000584721/];
const PAYLOAD_KEYS = ['code', 'phoneNumber', 'challengeId', 'purpose', 'returnvalue', 'stacktrace'];

function fail(message, code = 2) {
  console.error(`OTP RELEASE CHECK: ${message}`);
  process.exit(code);
}

if (['staging', 'production'].includes(process.env.APP_ENV)) {
  fail(`refusing to run with APP_ENV=${process.env.APP_ENV}`);
}
if (!REDIS_URL) fail('set RELEASE_CHECK_REDIS_URL to an isolated Redis (never production)');
if (!fs.existsSync(path.join(ROOT, 'dist/modules/admin/jobs-management/jobs.service.js'))) {
  fail(`no compiled build under ${ROOT}/dist — run it in the image, or after npm run build`);
}

// The compiled config loads an env file under APP_ENV=test and validates it at import.
// Give it a throwaway one naming only the isolated Redis; nothing here touches PostgreSQL.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-release-check-'));
fs.writeFileSync(
  path.join(scratch, '.env.test'),
  [
    'APP_ENV=test',
    'NODE_ENV=test',
    'DATABASE_URL=postgresql://release-check:unused@127.0.0.1:9/release_check_test',
    `REDIS_URL=${REDIS_URL}`,
    'JWT_ACCESS_SECRET=release_check_access_secret_padded_to_32',
    'JWT_REFRESH_SECRET=release_check_refresh_secret_padded_to_32',
    '',
  ].join('\n'),
);
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = REDIS_URL;
process.chdir(scratch);

const projectRequire = require('node:module').createRequire(path.join(ROOT, 'package.json'));
const { Worker } = projectRequire('bullmq');
const queues = require(path.join(ROOT, 'dist/jobs/queues/index.js'));
const { enqueueOtpDelivery } = require(path.join(ROOT, 'dist/jobs/producers/index.js'));
const { AdminJobsService } = require(
  path.join(ROOT, 'dist/modules/admin/jobs-management/jobs.service.js'),
);

function leaves(value, out = []) {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => leaves(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      leaves(v, out);
    }
  }
  return out;
}

/** The sensitive values and payload field names found anywhere in `value`. */
function exposures(value) {
  const all = leaves(value);
  return [
    ...LEAKS.filter((leak) => all.some((leaf) => leak.test(leaf))).map(String),
    ...PAYLOAD_KEYS.filter((key) => all.includes(key)),
  ];
}

async function main() {
  const queue = queues.otpQueue();
  const workers = await queue.getWorkers();
  if (workers.length > 0) {
    fail(`auth-otp has ${workers.length} worker(s) attached — this is not an isolated Redis`);
  }

  const data = (challengeId) => ({ challengeId, phoneNumber: PHONE, code: CODE, purpose: 'LOGIN' });
  const ids = {
    failed: randomUUID(),
    completed: randomUUID(),
    active: randomUUID(),
    waiting: randomUUID(),
    delayed: randomUUID(),
  };
  const worker = new Worker(queues.QUEUE_NAMES.AUTH_OTP, null, {
    connection: queues.createQueueConnection(),
    autorun: false,
  });
  const token = randomUUID();
  const results = [];
  const check = (label, value, extra = true) => {
    const found = exposures(value);
    const ok = found.length === 0 && extra === true;
    results.push(ok);
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${label}${found.length ? ` — exposes ${found.join(', ')}` : ''}` +
        `${extra === true ? '' : ` — ${extra}`}`,
    );
  };

  try {
    // Each job is put in its state deterministically: no worker processes it.
    await queue.add('otp-send', data(ids.failed), { jobId: ids.failed, attempts: 1 });
    const failing = await worker.getNextJob(token);
    await failing.moveToFailed(
      new Error(`SMS provider rejected ${PHONE}: "Your Zaroorat code is ${CODE}"`),
      token,
      false,
    );
    await queue.add('otp-send', data(ids.completed), {
      jobId: ids.completed,
      removeOnComplete: false,
    });
    const completing = await worker.getNextJob(token);
    await completing.moveToCompleted({ delivered: true, echo: `${PHONE}:${CODE}` }, token, false);
    await queue.add('otp-send', data(ids.active), { jobId: ids.active });
    await worker.getNextJob(token);
    await enqueueOtpDelivery(data(ids.waiting)); // the production producer
    await queue.add('otp-send', data(ids.delayed), { jobId: ids.delayed, delay: 3_600_000 });

    const auditRows = [];
    const service = new AdminJobsService({
      client: { adminActivityLog: { create: async ({ data: row }) => auditRows.push(row) } },
    });
    const actor = { actorId: randomUUID(), ipAddress: '127.0.0.1', userAgent: 'otp-release-check' };

    for (const [state, id] of Object.entries(ids)) {
      const job = await queue.getJob(id);
      if (job?.data?.code !== CODE) fail(`seeded ${state} job does not carry the code`);
      const list = await service.listQueueJobs({
        queue: 'auth-otp',
        status: state,
        page: 0,
        limit: 100,
      });
      const listed = list.data.find((j) => j.id === id);
      check(
        `list   ${state.padEnd(9)} data=${JSON.stringify(listed?.data ?? 'MISSING')}`,
        list,
        listed && listed.data === null && listed.status === state
          ? true
          : 'job missing or data shown',
      );
      const detail = await service.getJob('auth-otp', id);
      check(
        `detail ${state.padEnd(9)} data=${JSON.stringify(detail.data.data)}`,
        detail,
        detail.data.data === null && detail.data.status === state
          ? true
          : 'data shown or wrong state',
      );
    }

    const failedDetail = await service.getJob('auth-otp', ids.failed);
    check(`failed reason "${failedDetail.data.failedReason}"`, failedDetail.data.failedReason);

    const retried = await service.mutateJob('auth-otp', ids.failed, 'retry', actor);
    const removed = await service.mutateJob('auth-otp', ids.waiting, 'remove', actor);
    check(
      `retry/remove return ${JSON.stringify([retried, removed])}, ${auditRows.length} audit rows`,
      { retried, removed, auditRows },
      retried === undefined && removed === undefined && auditRows.length === 4
        ? true
        : 'unexpected return or audit rows',
    );
  } finally {
    // Remove only what this run created.
    const active = await queue.getJob(ids.active);
    if (active)
      await active.moveToFailed(new Error('release check cleanup'), token, false).catch(() => {});
    await worker.close(true);
    for (const id of Object.values(ids)) await queue.remove(id).catch(() => {});
    await queues.closeQueues();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const passed = results.length > 0 && results.every(Boolean);
  console.log(passed ? 'OTP RELEASE CHECK: PASS' : 'OTP RELEASE CHECK: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
