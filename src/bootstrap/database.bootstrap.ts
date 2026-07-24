import { DatabaseService, checkDatabaseHealth } from '@core/database/index.js';
import { registerReadinessCheck } from '@core/health/index.js';

export async function bootstrapDatabase(): Promise<void> {
  await DatabaseService.connect();

  // $connect() resolves without touching the server when a driver adapter is
  // used, so it alone proves nothing — a typo in DATABASE_URL would surface on
  // the first request instead of at boot. Issue a real query to fail fast.
  if (!(await checkDatabaseHealth())) {
    throw new Error('Database is unreachable; check DATABASE_URL.');
  }

  // From here on /ready reports 503 whenever the database is unreachable, so a
  // pod that loses its connection is pulled from the load balancer instead of
  // serving errors.
  registerReadinessCheck({
    name: 'database',
    probe: async () => {
      const healthy = await checkDatabaseHealth();

      if (!healthy) {
        throw new Error('database is not reachable');
      }
    },
  });
}
