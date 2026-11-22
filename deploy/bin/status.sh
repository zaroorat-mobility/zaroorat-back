#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/zaroorat/src"
COMPOSE_FILE="compose.dev.yml"

cd "$APP_DIR"
docker compose -f "$COMPOSE_FILE" ps
echo ""
echo "--- API Health ---"
curl -fsS http://127.0.0.1:3000/health || echo "API /health failed"
echo ""
echo "--- API Readiness ---"
curl -fsS http://127.0.0.1:3000/ready || echo "API /ready failed"
echo ""
