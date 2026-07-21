# Configuration Guide

This module defines and loads the application's environment configuration.

## Environment Variables

| Variable | Required | Secret | Used By | Description |
| :--- | :---: | :---: | :--- | :--- |
| `APP_ENV` | No (default `local`) | No | Loader / App | Determines the active deployment environment (`local`, `test`, `staging`, `production`). Determines which `.env` file to load. |
| `NODE_ENV` | No (default `development`) | No | Fastify / V8 | Used by Node and frameworks to toggle production optimizations (`development`, `production`, `test`). |
| `APP_NAME` | No | No | Logger / App | Human-readable name for the application (e.g., `zaroorat-backend`). |
| `HOST` | No (default `0.0.0.0`) | No | Fastify | The network interface the server will bind to. |
| `PORT` | No (default `3000`) | No | Fastify | The port the HTTP server will listen on. |
| `DATABASE_URL` | **Yes** | **Yes** | Prisma | Connection string for the PostgreSQL database. |
| `REDIS_URL` | **Yes** | **Yes** | Redis / BullMQ | Connection string for the Redis cache/queue. |
| `JWT_ACCESS_SECRET`| **Yes** | **Yes** | Auth | Secret key used to sign JSON Web Tokens (min 32 chars). |
| `JWT_REFRESH_SECRET`| **Yes** | **Yes** | Auth | Secret key used to sign Refresh Tokens (min 32 chars). |

## Startup Flow

1. **Loader** (`loader.ts`): Detects `APP_ENV` and loads the corresponding `.env` file using `dotenv`.
2. **Validator** (`validator.ts`): Uses `zod` to ensure all required variables are present and correctly formatted. **The application will crash gracefully if validation fails.**
3. **Environment** (`env.ts`): Creates a strictly-typed, read-only (`Object.freeze`) configuration object.
4. **Domain Configs** (e.g., `app.config.ts`, `database.config.ts`): Consume the validated environment to build domain-specific configuration objects.
