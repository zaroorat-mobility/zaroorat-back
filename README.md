# Zaroorat Backend

![Build](https://img.shields.io/github/actions/workflow/status/zaroorat-mobility/zaroorat-back/build.yml?branch=main)
![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)
![Node Version](https://img.shields.io/badge/node-v26.4.0-blue)

## Husky Hooks

We use Husky to enforce Git hooks across the team for linting, typechecking, and commit messages.

### Bypassing Husky in CI or Docker

In environments like CI/CD pipelines or Docker builds, you often do not need to install or run Husky. To skip Husky installation, run:

```bash
HUSKY=0 npm install
```

## Local Development Database

To start the database (PostgreSQL with PostGIS) via Docker, run the following command:

```bash
docker compose up -d postgres
```

Alternatively, to start the entire stack (API, Database, and Redis), you can run:

```bash
make up
```
