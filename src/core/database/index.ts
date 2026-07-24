// Export the core singleton instance
export { default as db } from './client';

// Export services and helpers
export { DatabaseService } from './service';
export { withTransaction } from './transactions';
export { checkDatabaseHealth } from './health';
export { extendedPrisma } from './extensions';

// Export shared types
export * from './types';
