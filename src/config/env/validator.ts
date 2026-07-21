import { EnvironmentSchema, Environment } from './schema.js';

export function validateEnvironment(): Environment {
  const parsed = EnvironmentSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Environment validation failed. Missing or invalid variables:');
    
    // Log the formatted errors nicely
    const errors = parsed.error.format();
    for (const [key, value] of Object.entries(errors)) {
      if (key !== '_errors' && (value as any)._errors) {
        console.error(`- ${key}: ${(value as any)._errors.join(', ')}`);
      }
    }
    
    process.exit(1);
  }

  return parsed.data;
}
