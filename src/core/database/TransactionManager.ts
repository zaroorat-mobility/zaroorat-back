import { ProviderClient, PrismaClientProvider } from './client/PrismaClientProvider';
import { PrismaErrorMapper } from './errors/PrismaErrorMapper';
import { Prisma } from '../../generated/prisma';

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * The interactive-transaction client handed to a transaction callback. It is the
 * full client minus lifecycle/extension methods, so repository writes can join a
 * caller's transaction (the transactional-outbox pattern).
 */
export type TransactionClient = Omit<
  ProviderClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Executes database transactions.
 * Depends on PrismaClientProvider directly to avoid a cyclic dependency
 * with DatabaseService.
 */
export class TransactionManager {
  constructor(private readonly provider: PrismaClientProvider) {}

  /**
   * Executes a callback inside a transaction with optional isolation level,
   * timeout, and maxWait. Only the options provided are forwarded to Prisma,
   * respecting exactOptionalPropertyTypes.
   */
  public async execute<T>(
    callback: (
      tx: Omit<
        ProviderClient,
        '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
      >,
    ) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    try {
      const txOptions: Record<string, unknown> = {};
      if (options?.maxWait !== undefined) txOptions.maxWait = options.maxWait;
      if (options?.timeout !== undefined) txOptions.timeout = options.timeout;
      if (options?.isolationLevel !== undefined) txOptions.isolationLevel = options.isolationLevel;

      return await this.provider.client.$transaction(callback, txOptions);
    } catch (error) {
      // The callback runs application code, so most of what surfaces here is a
      // domain error the caller threw on purpose to roll the transaction back
      // (AccountSuspendedError, PhoneInUseError, …). Those must reach the caller
      // as themselves; translating them would turn every deliberate 403/409 into
      // a 500. Only genuine driver failures are mapped.
      if (!PrismaErrorMapper.isPrismaError(error)) throw error;
      throw PrismaErrorMapper.mapError(error, 'Transaction Execution');
    }
  }
}
