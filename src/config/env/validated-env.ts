import { loadEnvironment } from './loader.js';
import { validateEnvironment } from './validator.js';
loadEnvironment();
export const validatedEnv = validateEnvironment();
