import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';
import * as path from 'path';

// 1. Environment Handling
// Dynamically load the correct .env file based on the environment
const env = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const envFile =
  env === 'production'
    ? '.env.production'
    : env === 'test' || env === 'testing'
      ? '.env.test'
      : '.env.development';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

export default defineConfig({
  // 3. Migration configuration
  // Pulling the URL from the dynamically loaded environment variables
  migrate: {
    url: process.env.DATABASE_URL,
  },
});
