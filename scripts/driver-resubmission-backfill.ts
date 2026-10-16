/**
 * One-off: moves drivers sent back for corrections before 2026-10-13 from REJECTED to PENDING,
 * so their next upload returns them to review. Selection rules and safety checks live in
 * src/modules/admin/driver-management/applications/resubmission-backfill.ts.
 *
 * Dry-run (the default; reads only). Review the eligible, excluded and manual-review lists
 * and note `plan.fingerprint`:
 *   APP_ENV=<env> npx tsx scripts/driver-resubmission-backfill.ts \
 *     --env <env> --database <db> --host <host[:port]>
 *
 * Apply exactly that reviewed plan:
 *   APP_ENV=<env> npx tsx scripts/driver-resubmission-backfill.ts \
 *     --env <env> --database <db> --host <host[:port]> \
 *     --apply --actor <admin user id> --plan <fingerprint>
 *
 * --env, --database and --host must name the environment, database and server this process
 * is actually connected to, or nothing runs. Development and test must be on loopback;
 * production and any remote server additionally need --allow-production. The operator must
 * be an active admin or system admin, and is re-checked for every driver. If the eligible
 * drivers or their source requests changed since the dry run, nothing is applied: run the dry
 * run again and review it.
 *
 * Exit status: 0 applied (or dry run) with no failures; 2 some drivers failed and the rest
 * were applied; 3 every driver failed; 1 refused or stopped part-way. A failed driver is left
 * untouched; rerun the dry run, review, and apply its new fingerprint.
 *
 * Prints driver ids, driver codes, audit ids and the server's host:port only — never phone
 * numbers, names, instructions or connection credentials.
 */
import { container } from '../src/core/di.js';
import { DatabaseService, type DatabaseConfiguration } from '../src/core/database/index.js';
import { config } from '../src/config/index.js';
import {
  applyResubmissionBackfill,
  assertAuthorizedActor,
  assertSafeTarget,
  BackfillAborted,
  databaseEndpoint,
  exitCodeFor,
  parseBackfillArgs,
  planResubmissionBackfill,
} from '../src/modules/admin/driver-management/applications/resubmission-backfill.js';

async function main(): Promise<number> {
  const options = parseBackfillArgs(process.argv.slice(2));
  // The very configuration the pool was built from, not a fresh read of the environment.
  const endpoint = databaseEndpoint(container.resolve<DatabaseConfiguration>('dbConfig').url);
  const client = container.resolve<DatabaseService>('databaseService').client;
  const [connected] = await client.$queryRaw<Array<{ database: string }>>`
    SELECT current_database() AS database`;
  const target = assertSafeTarget(options, {
    environment: config.app.environment,
    database: connected?.database ?? '',
    ...endpoint,
  });

  if (!options.apply) {
    const plan = await planResubmissionBackfill(client);
    const summary = {
      target,
      mode: 'dry-run',
      fingerprint: plan.fingerprint,
      scannedRejected: plan.scannedRejected,
      eligible: plan.eligible.length,
      excluded: plan.excluded.length,
      manualReview: plan.manualReview.length,
    };
    console.log(JSON.stringify({ ...summary, plan }, null, 2));
    return 0;
  }

  await assertAuthorizedActor(client, options.actor!);
  try {
    const applied = await applyResubmissionBackfill(
      client,
      { fingerprint: options.plan! },
      { actorId: options.actor! },
    );
    console.log(JSON.stringify({ target, mode: 'apply', applied }, null, 2));
    return exitCodeFor(applied);
  } catch (err) {
    if (err instanceof BackfillAborted) {
      console.log(JSON.stringify({ target, mode: 'apply', aborted: err.report }, null, 2));
    }
    throw err;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
