import { config } from '@config';
import { container } from '../core/di.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { RetryService } from '@core/database/retry/RetryService.js';
import { registerReadinessCheck } from '@core/health/index.js';

type RawQuery = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> };

/// What the connected role could do to the append-only audit trail, if anything: be a
/// superuser, own an audit table (or act as its owner through membership — enough to
/// disable or drop the triggers), or hold UPDATE, DELETE or TRUNCATE on one. Empty for
/// the restricted runtime login (docs/15_Security/database-roles.md).
export async function auditTrailRewriteRights(db: RawQuery): Promise<string[]> {
  const [row] = await db.$queryRawUnsafe<
    Array<{ role: string; superuser: boolean; owner: boolean; rewrite: boolean }>
  >(
    `SELECT current_user AS role,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            bool_or(pg_has_role(current_user, c.relowner, 'USAGE')) AS owner,
            bool_or(has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
                    OR has_table_privilege(c.oid, 'TRUNCATE')) AS rewrite
       FROM pg_class c
      WHERE c.oid IN ('public.admin_activity_logs'::regclass, 'public.audit_field_changes'::regclass)`,
  );
  if (!row) return ['audit tables not found'];
  return [
    ...(row.superuser ? [`"${row.role}" is a superuser`] : []),
    ...(row.owner ? [`"${row.role}" owns the audit tables`] : []),
    ...(row.rewrite ? [`"${row.role}" may UPDATE, DELETE or TRUNCATE audit rows`] : []),
  ];
}

/// Staging and production refuse to start as a role that can rewrite the audit trail. The
/// owner account belongs to migrations only; a DATABASE_URL that names it is a deployment
/// mistake, and serving traffic with it would leave every audit protection removable by
/// the application. Fails closed — there is no override. Development and test connect as
/// the owner on purpose (the test harness truncates).
export async function assertRestrictedDatabaseRole(db: RawQuery, environment: string) {
  if (environment !== 'production' && environment !== 'staging') return;
  const rights = await auditTrailRewriteRights(db);
  if (rights.length > 0) {
    throw new Error(
      `Refusing to start in ${environment}: DATABASE_URL connects as a role that can rewrite ` +
        `the audit trail (${rights.join('; ')}). Point DATABASE_URL at the restricted runtime ` +
        'login (member of zaroorat_app_runtime); the owner is for migrations only. ' +
        'See docs/15_Security/database-roles.md.',
    );
  }
}

export async function bootstrapDatabase(): Promise<void> {
  const provider = container.resolve<PrismaClientProvider>('provider');
  const retry = container.resolve<RetryService>('retryService');
  // Boot must outlast a database that is merely slow to arrive: a container
  // still starting, a failover, a long checkpoint. Three tries ~100ms apart
  // crash-looped the app against blips it should have ridden out. Ten tries
  // with capped exponential backoff is roughly a 30s budget.
  await retry.executeWithRetry(
    async () => {
      await provider.verifyConnection();
    },
    Number(process.env.DB_BOOT_RETRIES ?? 10),
    Number(process.env.DB_BOOT_RETRY_DELAY_MS ?? 250),
  );
  await assertRestrictedDatabaseRole(provider.client, config.app.environment);
  registerReadinessCheck({
    name: 'database',
    probe: async () => {
      const status = await provider.health();
      if (!status.healthy) {
        throw new Error('database is not reachable');
      }
    },
  });
}
