import prisma from './client';
import { PrismaClient } from '../../generated/prisma';

type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Wraps a callback in a Prisma transaction.
 * Use this to ensure atomic operations across multiple tables.
 */
export async function withTransaction<T>(
  callback: (tx: PrismaTransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return prisma.$transaction(callback, options);
}
