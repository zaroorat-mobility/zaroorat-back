import { Pool } from 'pg';
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
      ssl: dbConfig.sslMode === 'require' || dbConfig.sslMode === 'verify-full',
    });
    pool.on('connect', () => {
      this.databaseMetrics.recordConnectionEstablished();
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
        this.databaseMetrics.recordError('PrismaInternalError', e.message);
      },
    );
  }
}
