import { Environment, EnvironmentSchema } from './schema.js';
export function validateEnvironment(): Environment {
  const result = EnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    console.error('\n\u274C Environment validation failed.\n');
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      console.error(`- ${path}: ${issue.message}`);
    }
    console.error('\nFix the above environment variables and restart the application.\n');
    process.exit(1);
  }
  return result.data;
}
