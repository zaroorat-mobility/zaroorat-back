#!/usr/bin/env bash
#
# Restore a dump produced by db-backup.sh.
#
#   ./scripts/db-restore.sh backups/zaroorat-20260723T101500Z.dump
#
# This DROPS AND RECREATES every object it restores. It refuses to run against
# a production URL unless FORCE=1 is set explicitly.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP_FILE="${1:-}"

if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage: $0 <dump-file>" >&2
  echo "Available:" >&2
  ls -1t "$ROOT_DIR/backups"/*.dump 2> /dev/null | head -10 >&2 || echo "  (none)" >&2
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Error: $DUMP_FILE does not exist." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" && -f "$ROOT_DIR/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT_DIR/.env.local" | head -n1 | cut -d= -f2-)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set and could not be read from .env.local." >&2
  exit 1
fi

if ! command -v pg_restore > /dev/null 2>&1; then
  echo "Error: pg_restore not found. Install the postgresql-client package." >&2
  exit 1
fi

# Cheap guard against the classic "restored staging over prod" incident.
if [[ "${FORCE:-0}" != "1" ]]; then
  case "$DATABASE_URL" in
    *prod* | *production*)
      echo "Refusing to restore into what looks like a production database." >&2
      echo "Re-run with FORCE=1 if this is genuinely intended." >&2
      exit 1
      ;;
  esac
fi

# Strip credentials before echoing the target back to the operator.
SAFE_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#')"

echo "About to restore:"
echo "  from : $DUMP_FILE"
echo "  into : $SAFE_TARGET"
echo
read -r -p "This will overwrite existing data. Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# --clean --if-exists drops objects before recreating them; without --if-exists
# the first run against an empty database fails on every DROP.
# --exit-on-error surfaces a broken restore instead of leaving a half-populated db.
pg_restore \
  --dbname="$DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --jobs=4 \
  "$DUMP_FILE"

echo "Restore complete."
