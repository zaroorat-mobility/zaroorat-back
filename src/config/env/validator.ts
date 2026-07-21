import { Environment, EnvironmentSchema } from "./schema.js";

export function validateEnvironment(): Environment {
  const result = EnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    console.error("\n❌ Environment validation failed.\n");

    const formattedErrors = result.error.format();

    for (const [key, value] of Object.entries(formattedErrors)) {
      if (key === "_errors") continue;

      if ("_errors" in value && (value as any)._errors.length > 0) {
        console.error(`- ${key}: ${(value as any)._errors.join(", ")}`);
      }
    }

    console.error("\nFix the above environment variables and restart the application.\n");

    process.exit(1);
  }

  return result.data;
}
