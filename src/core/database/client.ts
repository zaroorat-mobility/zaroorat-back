import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma';

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * Prisma 7 requires an explicit driver adapter — `new PrismaClient()` with no
 * options throws at construction. The connection string is read here rather
 * than from the datasource block because schema.prisma no longer declares a
 * `url` (prisma.config.ts owns the migration URL).
 */
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot construct the Prisma client.');
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse a single instance across hot reloads in development, otherwise every
// reload leaks a connection pool.
export const prisma = global.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export default prisma;
