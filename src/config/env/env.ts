import { loadEnvironment } from './loader.js';
import { validateEnvironment } from './validator.js';

// 1. Load the files
loadEnvironment();

// 2. Validate the loaded environment
const validatedEnv = validateEnvironment();

// 3. Export a frozen object so other configuration domains can safely use it
export const env = Object.freeze(validatedEnv);
