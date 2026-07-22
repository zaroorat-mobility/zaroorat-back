# Zaroorat Backend — common tasks.
# Everything here is a thin wrapper; npm scripts remain the source of truth.

.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose
IMAGE   := zaroorat-backend

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

# ── Docker ────────────────────────────────────────────────────

.PHONY: up
up: ## Start API + Postgres + Redis
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack and delete its volumes
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail the API logs
	$(COMPOSE) logs -f api

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

.PHONY: shell
shell: ## Open a shell in the running API container
	$(COMPOSE) exec api sh

.PHONY: image
image: ## Build the production image locally
	docker build -t $(IMAGE):local .

# ── Database ──────────────────────────────────────────────────

.PHONY: db-shell
db-shell: ## Open psql against the local database
	$(COMPOSE) exec postgres psql -U zaroorat -d zaroorat

.PHONY: db-backup
db-backup: ## Dump the database to backups/
	./scripts/db-backup.sh

.PHONY: db-restore
db-restore: ## Restore from a dump: make db-restore FILE=backups/x.dump
	./scripts/db-restore.sh $(FILE)
