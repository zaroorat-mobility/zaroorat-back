#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/zaroorat/src"
COMPOSE_FILE="compose.dev.yml"

cd "$APP_DIR"

if [[ ! -f /opt/zaroorat/previous-image.txt ]]; then
  echo "Error: No previous deployment record found for rollback." >&2
  exit 1
fi

PREV_IMAGE="$(cat /opt/zaroorat/previous-image.txt)"
echo "==> Rolling back to $PREV_IMAGE"

APP_IMAGE="$PREV_IMAGE" docker compose -f "$COMPOSE_FILE" up -d --wait api worker caddy
echo "$PREV_IMAGE" > /opt/zaroorat/current-image.txt
echo "==> Rollback complete."
