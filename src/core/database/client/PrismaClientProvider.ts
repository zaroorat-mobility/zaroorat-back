import { PrismaClientFactory } from './PrismaClientFactory';
import { DatabaseConfiguration } from '../configuration/DatabaseConfiguration';
import { PoolConfiguration } from '../configuration/PoolConfiguration';
import { PrismaErrorMapper } from '../errors/PrismaErrorMapper';
import { ProviderState } from './ProviderState';
import { logger } from '@shared/logger/index.js';

export type ProviderClient = ReturnType<PrismaClientFactory['create']>;

export interface DatabaseHealth {
  healthy: boolean;
  latency: number;
  timestamp: Date;
}

/**
 * Infrastructure owner of the database connection lifecycle.
 *
 * Owns the singleton PrismaClient, startup verification, operational health,
 * and the state machine that prevents double-initialization or shutdown races.
 * Domain services and repositories must never touch this class directly —
 * they go through DatabaseService.
 */
export class PrismaClientProvider {
  private _client: ProviderClient | null = null;
  private _state: ProviderState = ProviderState.UNINITIALIZED;

  constructor(
    private readonly factory: PrismaClientFactory,
    private readonly dbConfig: DatabaseConfiguration,
    private readonly poolConfig: PoolConfiguration,
  ) {}

  /** Lazily initialises the singleton client on first access. */
  public get client(): ProviderClient {
    if (!this._client) {
      this._state = ProviderState.INITIALIZING;
      this._client = this.factory.create(this.dbConfig, this.poolConfig);
      this._state = ProviderState.CONNECTED;
    }
    return this._client;
  }

  /** Current lifecycle state — useful for observability and guard checks. */
  public get state(): ProviderState {
    return this._state;
  }

  /**
   * Verifies the connection at boot time via a raw round-trip.
   * Called only by database.bootstrap.ts — never by application code.
   */
  public async verifyConnection(): Promise<void> {
    try {
      await this.client.$queryRaw`SELECT 1`;
    } catch (error) {
      throw PrismaErrorMapper.mapError(error, 'Database Verification');
    }
  }

  /**
   * Operational health check for Kubernetes readiness probes.
   * Called only by database.bootstrap.ts — never by application code.
   */
  public async health(): Promise<DatabaseHealth> {
    const start = performance.now();
    try {
      await this.client.$queryRaw`SELECT 1`;
      return {
        healthy: true,
        latency: Math.round(performance.now() - start),
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error({ error }, '[DB Health] Health check failed');
      return {
        healthy: false,
        latency: Math.round(performance.now() - start),
        timestamp: new Date(),
      };
    }
  }

  /**
   * Closes the connection pool.
   * Called only by shutdown.bootstrap.ts — never by application code.
   */
  public async disconnect(): Promise<void> {
    if (this._client && this._state !== ProviderState.DISCONNECTING) {
      try {
        this._state = ProviderState.DISCONNECTING;
        await this._client.$disconnect();
        this._client = null;
        this._state = ProviderState.DISCONNECTED;
      } catch (error) {
        this._state = ProviderState.CONNECTED;
        throw PrismaErrorMapper.mapError(error, 'Database Disconnect');
      }
    }
  }
}
