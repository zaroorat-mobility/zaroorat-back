import { ProviderClient, PrismaClientProvider } from './client/PrismaClientProvider';
import { PrismaErrorMapper } from './errors/PrismaErrorMapper';
import { Prisma } from '../../generated/prisma';
export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}
export type TransactionClient = Omit<
  ProviderClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
export class TransactionManager {
  constructor(private readonly provider: PrismaClientProvider) {}
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
      if (!PrismaErrorMapper.isPrismaError(error)) throw error;
      throw PrismaErrorMapper.mapError(error, 'Transaction Execution');
    }
  }
}
