# Zaroorat Backend — common tasks.
# Everything here is a thin wrapper; npm scripts remain the source of truth.

.DEFAULT_GOAL := help
SHELL := /bin/bash

IMAGE     := zaroorat-backend
DEV       := docker compose -f compose.dev.yml
TEST      := docker compose -f compose.test.yml
PROD      := docker compose -f compose.prod.yml

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

# ── Docker: development ──────────────────────────

.PHONY: build-dev
build-dev: ## Build the development images
	$(DEV) build

# compose.dev.yml mounts .env.development into the containers because
# loader.ts requires it to exist. If the host file is missing, Docker would
# silently create a DIRECTORY at that path, so create it first.
.PHONY: env-dev
env-dev:
	@test -f .env.development || { cp .env.example .env.development; echo "Created .env.development from .env.example - review it before use."; }

.PHONY: up-dev
up-dev: env-dev ## Start API + Worker + Postgres + Redis with hot reload
	$(DEV) up -d --build

# Hot reload lives here, not in `up-dev`. Runs in the foreground: Compose polls
# the host for changes and syncs them into the containers, which is what makes
# tsx watch fire on Windows and macOS. Ctrl-C stops watching, not the stack.
.PHONY: watch-dev
watch-dev: env-dev ## Start the dev stack and hot-reload on source changes (foreground)
	$(DEV) watch

.PHONY: down-dev
down-dev: ## Stop the dev stack and delete its volumes
	$(DEV) down -v

.PHONY: stop-dev
stop-dev: ## Stop the dev stack but keep the database
	$(DEV) down

.PHONY: logs-dev
logs-dev: ## Tail the dev API logs
	$(DEV) logs -f api

.PHONY: worker-logs-dev
worker-logs-dev: ## Tail the dev worker logs (queues, incl. OTP SMS delivery)
	$(DEV) logs -f worker

.PHONY: ps-dev
ps-dev: ## Show dev container status
	$(DEV) ps

.PHONY: shell-dev
shell-dev: ## Open a shell in the running dev API container
	$(DEV) exec api sh

.PHONY: migrate-dev
migrate-dev: env-dev ## Apply migrations to the dev database
	$(DEV) run --rm migrate

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
migrate-prod: ## Run migrations once, before rolling the app (deployment step)
	$(PROD) run --rm migrate

.PHONY: up-prod
up-prod: ## Start the production stack
	$(PROD) up -d

.PHONY: down-prod
down-prod: ## Stop the production stack (volumes are PRESERVED)
	$(PROD) down

.PHONY: restart-prod
restart-prod: ## Restart the production API and worker
	$(PROD) restart api worker

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
