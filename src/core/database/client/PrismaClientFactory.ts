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

/**
 * Typed interfaces for Prisma event payloads.
 * If Prisma renames these fields in a future version, TypeScript surfaces
 * the regression at compile time rather than silently breaking metrics.
 */
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

/**
 * Instantiates and configures the PrismaClient.
 *
 * Owns pg Pool creation, driver adapter wiring, domain extension composition,
 * and observability hook attachment. Does NOT own the client lifecycle —
 * connect/disconnect belongs to PrismaClientProvider.
 *
 * All domain extensions are merged into a single $extends() call to avoid
 * the type incompatibility that arises from chaining separate extension
 * functions that accept PrismaClient but receive DynamicClientExtensionThis.
 */
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
        if (e.duration > 100) {
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
