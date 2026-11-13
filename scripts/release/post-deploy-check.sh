#!/usr/bin/env bash
# Post-deploy checks run by staging.yml and production.yml after `helm upgrade`.
# Covers the externally observable part of handover Appendix A.2:
#   1. liveness  (/health)  — the process is up behind the load balancer
#   2. readiness (/ready)   — database, Redis and other registered dependencies answer
#   3. realtime handshake   — the Socket.IO endpoint is reachable through the
#                             ingress/LB (engine.io open packet; no auth needed)
#
# Env:
#   BASE_URL          public base URL, e.g. https://api.zaroorat.com (no trailing slash)
#   REALTIME_PATH     Socket.IO path (default /socket.io)
#   REQUIRE_BASE_URL  'true' to fail when BASE_URL is empty (production)
#   ATTEMPTS / SLEEP  retry budget (default 10 x 6s)
set -euo pipefail

BASE_URL="${BASE_URL%/}"
REALTIME_PATH="${REALTIME_PATH:-/socket.io}"
ATTEMPTS="${ATTEMPTS:-10}"
SLEEP="${SLEEP:-6}"

if [ -z "$BASE_URL" ]; then
  if [ "${REQUIRE_BASE_URL:-false}" = "true" ]; then
    echo "::error::BASE_URL is not set; cannot verify the deployment."
    exit 1
  fi
  echo "::warning::BASE_URL is not set; skipping post-deploy checks."
  exit 0
fi

retry() {
  local name="$1"; shift
  for i in $(seq 1 "$ATTEMPTS"); do
    if "$@"; then
      echo "PASS  $name"
      return 0
    fi
    echo "      $name not ready (attempt $i/$ATTEMPTS)"
    sleep "$SLEEP"
  done
  echo "::error::$name failed after $ATTEMPTS attempts."
  return 1
}

check_health() { curl -fsS --max-time 5 "$BASE_URL/health" > /dev/null; }

check_ready() {
  local body
  body="$(curl -fsS --max-time 5 "$BASE_URL/ready")" || return 1
  echo "      /ready -> $body"
}

check_realtime() {
  local body
  body="$(curl -fsS --max-time 5 "$BASE_URL${REALTIME_PATH}/?EIO=4&transport=polling")" || return 1
  # engine.io v4 open packet: "0{\"sid\":...}"
  [[ "$body" == 0\{* ]]
}

failed=0
retry "liveness /health" check_health || failed=1
retry "readiness /ready" check_ready || failed=1
retry "Socket.IO handshake ${REALTIME_PATH}" check_realtime || failed=1

if [ "$failed" -ne 0 ]; then
  echo "::error::Post-deploy checks failed for $BASE_URL"
  exit 1
fi
echo "All post-deploy checks passed for $BASE_URL"
