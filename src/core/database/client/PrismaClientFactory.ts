import { Pool } from 'pg';
import { logger } from '@shared/logger/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma';
import { DatabaseConfiguration } from '../configuration/DatabaseConfiguration';
import { PoolConfiguration } from '../configuration/PoolConfiguration';
import { DatabaseMetrics } from '../monitoring/DatabaseMetrics';
import {
  userExtension,
  driverExtension,
  rideExtension,
  paymentExtension,
  pricingExtension,
} from '../extensions';
/// A query slower than this is warned about. Configurable because the useful
/// value differs by environment: a containerised Postgres on a developer laptop
/// crosses 100ms on writes that are entirely healthy in production, and the
/// resulting stream of warnings buries everything else in the terminal.
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS ?? 100);

/// node-postgres takes `ssl` as false | true | TLS options. `true` means
/// "verify against Node's built-in CA store", which no managed provider with a
/// private CA (RDS, Cloud SQL, Aiven) satisfies — hence the need to pass a
/// bundle. Postgres' own modes differ and are honoured here:
///   disable      no TLS
///   require      encrypt; do not verify the server's identity (verify the
///                chain only when a CA was supplied, matching libpq)
///   verify-full  encrypt and verify chain + hostname
function resolveSsl(dbConfig: DatabaseConfiguration): boolean | Record<string, unknown> {
  const mode = dbConfig.sslMode ?? 'disable';
  if (mode === 'disable') return false;

  const ca = dbConfig.sslRootCert;
  if (mode === 'verify-full') return ca ? { ca } : true;
  return ca ? { ca, checkServerIdentity: () => undefined } : { rejectUnauthorized: false };
}

interface PrismaQueryEvent {
  query: string;
  params: string;
  duration: number;
  target: string;
}
interface PrismaErrorEvent {
  message: string;
  target: string;
}

/// A constraint the application deliberately relies on — a duplicate email, a
/// second saved place with the same label — is a 4xx the route handler already
/// answers correctly. Logging it at ERROR and counting it as an internal fault
/// means ordinary user behaviour lights up the error dashboard and pages
/// whoever is on call.
const EXPECTED_CONSTRAINT =
  /unique constraint|foreign key constraint|check constraint|violates not-null/i;
export class PrismaClientFactory {
  constructor(private readonly databaseMetrics: DatabaseMetrics) {}
  public create(dbConfig: DatabaseConfiguration, poolConfig: PoolConfiguration) {
    const pool = new Pool({
      connectionString: dbConfig.url,
      application_name: dbConfig.applicationName,
      max: poolConfig.max,
      min: poolConfig.min,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
      ssl: resolveSsl(dbConfig),
      // Managed Postgres, pgbouncer and cloud NAT gateways all drop idle TCP
      // connections silently (AWS NAT: 350s). Without keepalive the pool hands
      // out a dead socket and the next query fails with "Server has closed the
      // connection" — the failure looks like a database fault but is a stale
      // socket in this process.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    pool.on('connect', () => {
      this.databaseMetrics.recordConnectionEstablished();
    });
    // node-postgres emits 'error' on the POOL when an *idle* client's connection
    // dies (failover, admin shutdown, idle reaper on the server side). An
    // unhandled 'error' event on an EventEmitter throws, which took the whole
    // process down. The pool discards the client on its own; all we must do is
    // not die. A live query's failure still rejects its own promise.
    pool.on('error', (error: Error) => {
      this.databaseMetrics.recordError('PoolIdleClientError', error.message);
      logger.warn({ err: error }, '[DB Pool] idle client dropped; the pool will reconnect');
    });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
    this.attachObservability(prisma);
    return prisma
      .$extends(userExtension)
      .$extends(driverExtension)
      .$extends(rideExtension)
      .$extends(paymentExtension)
      .$extends(pricingExtension);
  }
  private attachObservability(prisma: PrismaClient): void {
    (prisma.$on as (event: 'query', cb: (e: PrismaQueryEvent) => void) => void)(
      'query',
      (e: PrismaQueryEvent) => {
        if (e.duration > SLOW_QUERY_MS) {
          this.databaseMetrics.recordSlowQuery(e.query, e.duration);
        }
      },
    );
    (prisma.$on as (event: 'error', cb: (e: PrismaErrorEvent) => void) => void)(
      'error',
      (e: PrismaErrorEvent) => {
        if (EXPECTED_CONSTRAINT.test(e.message)) {
          logger.debug({ target: e.target }, '[DB] constraint rejected a write, as designed');
          return;
        }
        this.databaseMetrics.recordError('PrismaInternalError', e.message);
      },
    );
  }
}
