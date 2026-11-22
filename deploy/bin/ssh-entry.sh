#!/usr/bin/env bash
set -euo pipefail

ORIGINAL_CMD="${SSH_ORIGINAL_COMMAND:-}"

if [[ -z "$ORIGINAL_CMD" ]]; then
  echo "Error: Interactive terminal sessions are disabled for this deploy key." >&2
  exit 1
fi

case "$ORIGINAL_CMD" in
  deploy\ *)
    exec /opt/zaroorat/src/deploy/bin/deploy.sh ${ORIGINAL_CMD#deploy }
    ;;
  status)
    exec /opt/zaroorat/src/deploy/bin/status.sh
    ;;
  rollback)
    exec /opt/zaroorat/src/deploy/bin/rollback.sh
    ;;
  *)
    echo "Error: Command not allowed. Permitted: deploy <sha> <digest>, status, rollback." >&2
    exit 1
    ;;
esac
