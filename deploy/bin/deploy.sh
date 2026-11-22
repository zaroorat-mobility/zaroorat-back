#!/usr/bin/env bash
set -euo pipefail

SHA="${1:-}"
DIGEST="${2:-}"

if [[ -z "$SHA" || -z "$DIGEST" ]]; then
  echo "Usage: $0 <git-sha> <image-digest>" >&2
  exit 1
fi

APP_DIR="/opt/zaroorat/src"
LOCK_FILE="/tmp/zaroorat-deploy.lock"
COMPOSE_FILE="compose.dev.yml"
REGISTRY_IMAGE="ghcr.io/zaroorat-mobility/zaroorat-backend"

cd "$APP_DIR"

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "Error: Another deployment is currently in progress." >&2
  exit 1
fi

echo "==> Deploying commit $SHA ($DIGEST)"

# 1. Update working tree to the target commit
git fetch origin develop
git checkout --detach "$SHA"

# 2. Pull immutable image by digest
IMAGE_REF="${REGISTRY_IMAGE}@${DIGEST}"
echo "==> Pulling image $IMAGE_REF"
docker pull "$IMAGE_REF"

# 3. Pull ops image by digest if available or tag
OPS_REF="${REGISTRY_IMAGE}:sha-${SHA}-ops"
docker pull "$OPS_REF" || true

# 4. Save previous deployment pointer for rollback
PREV_IMAGE=""
if [[ -f /opt/zaroorat/current-image.txt ]]; then
  PREV_IMAGE="$(cat /opt/zaroorat/current-image.txt)"
fi

# 5. Run database migrations
echo "==> Executing database migrations"
APP_IMAGE="$IMAGE_REF" OPS_IMAGE="$OPS_REF" docker compose --env-file "${APP_ENV_FILE:-.env.dev}" -f "$COMPOSE_FILE" run --rm migrate

# 6. Ensure runtime database login and grants
echo "==> Verifying runtime database roles"
APP_IMAGE="$IMAGE_REF" OPS_IMAGE="$OPS_REF" docker compose --env-file "${APP_ENV_FILE:-.env.dev}" -f "$COMPOSE_FILE" run --rm db-roles

# 7. Roll application services with healthcheck wait
echo "==> Starting application containers"
if ! APP_IMAGE="$IMAGE_REF" OPS_IMAGE="$OPS_REF" docker compose --env-file "${APP_ENV_FILE:-.env.dev}" -f "$COMPOSE_FILE" up -d --wait api worker caddy; then
  echo "::error:: Deployment failed during container startup. Initiating rollback..." >&2
  if [[ -n "$PREV_IMAGE" ]]; then
    APP_IMAGE="$PREV_IMAGE" docker compose --env-file "${APP_ENV_FILE:-.env.dev}" -f "$COMPOSE_FILE" up -d --wait api worker caddy || true
  fi
  exit 1
fi

# 8. Record successful deployment
echo "$IMAGE_REF" > /opt/zaroorat/current-image.txt
if [[ -n "$PREV_IMAGE" ]]; then
  echo "$PREV_IMAGE" > /opt/zaroorat/previous-image.txt
fi

echo "==> Deployment successful: $SHA"
