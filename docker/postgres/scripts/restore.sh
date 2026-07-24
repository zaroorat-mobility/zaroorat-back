#!/bin/bash
set -e

BACKUP_FILE=$1
DB_NAME=${2:-zaroorat_dev}
DB_USER=${3:-zaroorat}

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <path_to_backup_file> [database_name] [username]"
  echo "Example: $0 docker/postgres/backups/zaroorat_dev_20260724_000000.dump"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Change directory to the root of the project to run docker compose
cd "$(dirname "$0")/../../.."

echo "Restoring database '${DB_NAME}' from '${BACKUP_FILE}'..."

# -c drops database objects before recreating them
# --if-exists avoids errors if dropping objects that don't exist yet
# -1 runs the restore as a single transaction
cat "$BACKUP_FILE" | docker compose exec -T postgres pg_restore -U "$DB_USER" -d "$DB_NAME" -c --if-exists -1

echo "Restore completed successfully!"
