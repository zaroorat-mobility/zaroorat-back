# Zaroorat Backend — common tasks.
# Everything here is a thin wrapper; npm scripts remain the source of truth.

.DEFAULT_GOAL := help
SHELL := /bin/bash

IMAGE     := zaroorat-backend
LOCAL     := docker compose --env-file .env.local -f compose.local.yml
DEV       := docker compose --env-file .env.dev -f compose.dev.yml
STAGING   := docker compose --env-file .env.staging -f compose.staging.yml
PROD      := docker compose --env-file .env.prod -f compose.prod.yml
TEST      := docker compose --env-file .env.test -f compose.test.yml

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Development ───────────────────────────────────────────────

.PHONY: install
install: ## Install dependencies from the lockfile
	npm ci

.PHONY: dev
dev: ## Run the API with hot reload
	npm run dev

.PHONY: build
build: ## Compile TypeScript to dist/
	npm run build

.PHONY: clean
clean: ## Remove build output and the incremental cache
	npm run clean

# ── Quality ───────────────────────────────────────────────────

.PHONY: lint
lint: ## Lint (no warnings allowed)
	npm run lint

.PHONY: format
format: ## Rewrite files with Prettier
	npm run format

.PHONY: typecheck
typecheck: ## Type-check without emitting
	npm run typecheck

.PHONY: test
test: ## Run the test suite
	npm test

.PHONY: verify
verify: lint typecheck test build ## Run everything CI runs

# ── Docker: local development ──────────────────────

.PHONY: build-local
build-local: ## Build the local development images
	$(LOCAL) build

.PHONY: env-local
env-local:
	@test -f .env.local || { cp .env.local.example .env.local; echo "Created .env.local from .env.local.example - review it before use."; }

.PHONY: up-local
up-local: env-local ## Start local stack (API + Worker + Postgres + Valkey)
	$(LOCAL) up -d --build

.PHONY: watch-local
watch-local: env-local ## Start the local stack with Compose file watch (foreground)
	$(LOCAL) watch

.PHONY: stop-local
stop-local: ## Stop the local stack and KEEP database volumes
	$(LOCAL) stop

.PHONY: down-local
down-local: ## Tear down containers and networks but KEEP database volumes
	$(LOCAL) down

.PHONY: reset-local
reset-local: ## Tear down containers and DELETE local database volumes
	$(LOCAL) down -v

.PHONY: logs-local
logs-local: ## Tail local API logs
	$(LOCAL) logs -f api

.PHONY: worker-logs-local
worker-logs-local: ## Tail local worker logs
	$(LOCAL) logs -f worker

.PHONY: ps-local
ps-local: ## Show local container status
	$(LOCAL) ps

.PHONY: shell-local
shell-local: ## Open shell in the running local API container
	$(LOCAL) exec api sh

.PHONY: migrate-local
migrate-local: env-local ## Apply database migrations locally
	$(LOCAL) run --rm migrate

.PHONY: seed-local
seed-local: env-local ## Seed local database fixtures
	$(LOCAL) run --rm -e APP_ENV=local migrate npx prisma db seed

# ── Docker: dev ──────────────────────────────────

.PHONY: build-dev
build-dev: ## Build the dev image
	$(DEV) build

.PHONY: up-dev
up-dev: ## Start the dev stack
	$(DEV) up -d

.PHONY: down-dev
down-dev: ## Stop the dev stack (volumes PRESERVED)
	$(DEV) down

.PHONY: logs-dev
logs-dev: ## Tail the dev API and worker logs
	$(DEV) logs -f api worker

.PHONY: migrate-dev
migrate-dev: ## Run migrations and assert runtime DB roles on dev
	$(DEV) run --rm migrate
	$(DEV) run --rm db-roles

.PHONY: seed-dev
seed-dev: ## Seed reference data on dev
	$(DEV) run --rm ops npx prisma db seed

.PHONY: admin-dev
admin-dev: ## Provision admin user on dev
	$(DEV) run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts

# ── Docker: staging ──────────────────────────────

.PHONY: build-staging
build-staging: ## Build the staging image
	$(STAGING) build

.PHONY: up-staging
up-staging: ## Start the staging stack
	$(STAGING) up -d

.PHONY: down-staging
down-staging: ## Stop the staging stack (volumes PRESERVED)
	$(STAGING) down

.PHONY: logs-staging
logs-staging: ## Tail the staging API and worker logs
	$(STAGING) logs -f api worker

.PHONY: migrate-staging
migrate-staging: ## Run migrations and assert runtime DB roles on staging
	$(STAGING) run --rm migrate
	$(STAGING) run --rm db-roles

.PHONY: seed-staging
seed-staging: ## Seed reference data on staging
	$(STAGING) run --rm ops npx prisma db seed

.PHONY: admin-staging
admin-staging: ## Provision admin user on staging
	$(STAGING) run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts

# ── Docker: test ─────────────────────────────────

# `run --rm` propagates the suite's exit code; the trap tears the stack down
# either way so a failed run does not leave postgres/redis behind.
.PHONY: test-docker
test-docker: ## Run the full suite in Docker (Postgres + Redis), then clean up
	@$(TEST) run --rm test; status=$$?; $(TEST) down -v >/dev/null 2>&1; exit $$status

.PHONY: up-test
up-test: ## Start the test infrastructure only (Postgres + Redis)
	$(TEST) up -d postgres redis

.PHONY: down-test
down-test: ## Stop the test stack and delete its volumes
	$(TEST) down -v

.PHONY: logs-test
logs-test: ## Tail the test runner logs
	$(TEST) logs -f test

# ── Docker: production ───────────────────────────

# Every prod target needs POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_ACCESS_SECRET
# and JWT_REFRESH_SECRET in the environment. compose.prod.yml fails loudly if
# any is missing. Never put them in this file.

.PHONY: build-prod
build-prod: ## Build the production image
	$(PROD) build

.PHONY: migrate-prod
migrate-prod: ## Run migrations once, then (re)provision the runtime DB login (deployment step)
	$(PROD) run --rm migrate
	$(PROD) run --rm db-roles

.PHONY: up-prod
up-prod: ## Start the production stack
	$(PROD) up -d

.PHONY: down-prod
down-prod: ## Stop the production stack (volumes are PRESERVED)
	$(PROD) down

.PHONY: restart-prod
restart-prod: ## Restart the production API and worker
	$(PROD) restart api worker

.PHONY: seed-prod
seed-prod: ## Seed reference data on prod
	$(PROD) run --rm ops npx prisma db seed

.PHONY: admin-prod
admin-prod: ## Provision admin user on prod
	$(PROD) run --rm -e ADMIN_EMAIL -e ADMIN_PHONE -e ADMIN_PASSWORD -e ADMIN_FIRST_NAME -e ADMIN_LAST_NAME ops npx tsx scripts/create-admin.ts

.PHONY: logs-prod
logs-prod: ## Tail the production API logs
	$(PROD) logs -f api

.PHONY: ps-prod
ps-prod: ## Show production container status
	$(PROD) ps

.PHONY: image
image: ## Build the production image standalone
	docker build -t $(IMAGE):local .

# ── Validation ──────────────────────────────────

.PHONY: config-dev
config-dev: ## Validate compose.dev.yml
	$(DEV) config -q && echo "compose.dev.yml OK"

.PHONY: config-test
config-test: ## Validate compose.test.yml
	$(TEST) config -q && echo "compose.test.yml OK"

.PHONY: config-prod
config-prod: ## Validate compose.prod.yml (requires the prod env vars)
	$(PROD) config -q && echo "compose.prod.yml OK"

.PHONY: config-all
config-all: config-dev config-test ## Validate the compose files that need no secrets

# ── Database ───────────────────────────────────

.PHONY: db-shell
db-shell: ## Open psql against the local development database
	$(DEV) exec postgres psql -U zaroorat -d zaroorat_dev

.PHONY: db-backup
db-backup: ## Dump the database to backups/
	./scripts/db-backup.sh

.PHONY: db-restore
db-restore: ## Restore from a dump: make db-restore FILE=backups/x.dump
	./scripts/db-restore.sh $(FILE)
