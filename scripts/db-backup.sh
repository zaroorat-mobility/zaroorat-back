#!/usr/bin/env bash
#
# Dump the Postgres database to backups/.
#
#   ./scripts/db-backup.sh                 # uses DATABASE_URL
#   DATABASE_URL=postgres://... ./scripts/db-backup.sh
#
# Uses the custom format (-Fc) so db-restore.sh can restore selectively and
# in parallel. Plain SQL dumps cannot do either.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# Load DATABASE_URL from .env.local only if it is not already in the environment.
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT_DIR/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT_DIR/.env.local" | head -n1 | cut -d= -f2-)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set and could not be read from .env.local." >&2
  exit 1
fi

if ! command -v pg_dump > /dev/null 2>&1; then
  echo "Error: pg_dump not found. Install the postgresql-client package." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTFILE="$BACKUP_DIR/zaroorat-$TIMESTAMP.dump"

echo "Backing up to $OUTFILE"

# Write to a temp file first so an interrupted dump never looks like a good backup.
TMPFILE="$OUTFILE.partial"
trap 'rm -f "$TMPFILE"' EXIT

pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$TMPFILE"

mv "$TMPFILE" "$OUTFILE"
trap - EXIT

echo "Backup complete: $(du -h "$OUTFILE" | cut -f1)"

# Prune old dumps. -mtime +N is "older than N days".
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -name 'zaroorat-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete
fi
