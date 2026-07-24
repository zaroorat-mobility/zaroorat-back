#!/bin/bash
set -e

# Change directory to the root of the project to run docker compose
cd "$(dirname "$0")/../../.."

# Configuration
DB_NAME=${1:-zaroorat_dev}
DB_USER=${2:-zaroorat}

BACKUP_DIR="docker/postgres/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "Starting backup of database '${DB_NAME}'..."

# We use custom format (-F c) which is highly compressed and suitable for pg_restore
docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$BACKUP_FILE"

echo "Backup successful! Saved to: $BACKUP_FILE"
