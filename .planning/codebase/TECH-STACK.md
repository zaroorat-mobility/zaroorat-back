# Tech Stack & Dependencies

## Core Technologies

- **Runtime**: Node.js (CommonJS mode, `tsx` for TypeScript execution)
- **Framework**: Fastify 5.x
- **Language**: TypeScript 6.x
- **Database**: PostgreSQL with Prisma 7.9.0 ORM (`@prisma/adapter-pg`)
- **Cache & Message Broker**: Redis (`ioredis`)
- **Job Queue**: BullMQ
- **WebSockets**: Socket.IO 4.8 with Redis Adapter
- **Geospatial**: Uber H3 (`h3-js`)
- **Validation**: Zod
- **Dependency Injection**: Awilix & `@fastify/awilix`
- **Cloud Storage**: AWS S3 SDK v3

## Code Quality & Tooling

- **Linter**: ESLint 10.x with TypeScript ESLint
- **Formatter**: Prettier 3.x
- **Git Hooks**: Husky & lint-staged
- **Commit Linting**: Commitlint with conventional config
