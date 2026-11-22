#!/usr/bin/env bash
# DEV deploy entry point: deploy | rollback | status.
#
# Runs as root, only through `sudo -n /usr/local/sbin/zaroorat-deploy` from zaroorat-ssh-entry
# (deploy key) or by an admin. Installed root-owned, outside the git checkout, and re-installed
# by an admin after every reviewed change to this file:
#   install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/deploy.sh /usr/local/sbin/zaroorat-deploy
#
# Server layout (all root-owned; see docs/DEPLOYMENT/DROPLET_DEV_AND_PROD_DEPLOYMENT_GUIDE.md):
#   /opt/zaroorat/src       git checkout of zaroorat-back (detached at the deployed commit)
#   /opt/zaroorat/env/dev.env   the single DEV env file (Compose interpolation + app env_file), 0600
#   /opt/zaroorat/state     current.env / previous.env release records (image digests + commit)
#
# Images are never built here: both are pulled by digest, and the runtime image's
# org.opencontainers.image.revision label must equal the commit being deployed.
# Database migrations are forward-only; rollback swaps images and checkout, never the schema.
set -euo pipefail
umask 077

SRC=/opt/zaroorat/src
ENV_FILE=/opt/zaroorat/env/dev.env
STATE=/opt/zaroorat/state
REPO=ghcr.io/zaroorat-mobility/zaroorat-backend
LOCK=/run/lock/zaroorat-deploy.lock

die() {
  echo "error: $*" >&2
  exit 1
}

# $1 = release file (APP_IMAGE, OPS_IMAGE, GIT_SHA); the remaining arguments go to compose.
dc() {
  local release=$1
  shift
  APP_ENV_FILE=$ENV_FILE docker compose --project-directory "$SRC" -f "$SRC/compose.dev.yml" \
    --env-file "$ENV_FILE" --env-file "$release" "$@"
}

ready() { # release service port
  dc "$1" exec -T "$2" node -e \
    "fetch('http://127.0.0.1:$3/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

sha_of() { sed -n 's/^GIT_SHA=//p' "$1"; }

# Matching checkout (compose file, Caddyfile), containers, then readiness of api and worker.
start() { # release
  git -C "$SRC" checkout --quiet --detach "$(sha_of "$1")" &&
    dc "$1" up -d --no-build --wait --wait-timeout 180 api worker caddy &&
    ready "$1" api 3000 &&
    ready "$1" worker 3001
}

lock() {
  exec 9> "$LOCK"
  flock -w 600 9 || die "another deploy is still running"
}

deploy() {
  local sha=$1 app=$2 ops=$3 next=$STATE/next.env rev
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "invalid commit sha"
  [[ $app =~ ^sha256:[0-9a-f]{64}$ && $ops =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid image digest"
  lock
  git -C "$SRC" fetch --quiet origin develop
  git -C "$SRC" merge-base --is-ancestor "$sha" origin/develop || die "$sha is not on origin/develop"
  docker pull --quiet "$REPO@$app" > /dev/null
  docker pull --quiet "$REPO@$ops" > /dev/null
  rev=$(docker image inspect "$REPO@$app" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ $rev == "$sha" ]] || die "image $app was built from '$rev', not $sha"
  printf 'APP_IMAGE=%s@%s\nOPS_IMAGE=%s@%s\nGIT_SHA=%s\n' "$REPO" "$app" "$REPO" "$ops" "$sha" > "$next"
  git -C "$SRC" checkout --quiet --detach "$sha"
  # set -e: a failed migration stops here and the running release keeps serving.
  dc "$next" run --rm migrate
  dc "$next" run --rm db-roles
  if start "$next"; then
    if [[ -f $STATE/current.env ]]; then mv "$STATE/current.env" "$STATE/previous.env"; fi
    mv "$next" "$STATE/current.env"
    echo "deployed $sha"
  else
    echo "error: release $sha failed its health checks" >&2
    if [[ -f $STATE/current.env ]]; then
      echo "restoring the previous release $(sha_of "$STATE/current.env")" >&2
      start "$STATE/current.env" || echo "error: restoring the previous release ALSO failed" >&2
    fi
    exit 1
  fi
}

rollback() {
  lock
  [[ -f $STATE/previous.env ]] || die "no previous release recorded"
  start "$STATE/previous.env" || die "previous release failed its health checks"
  mv "$STATE/current.env" "$STATE/rolled-back.env"
  mv "$STATE/previous.env" "$STATE/current.env"
  echo "rolled back to $(sha_of "$STATE/current.env"); database migrations are NOT reverted"
}

status() {
  [[ -f $STATE/current.env ]] || die "nothing deployed yet"
  cat "$STATE/current.env"
  dc "$STATE/current.env" ps
  if ready "$STATE/current.env" api 3000; then echo "api: ready"; else echo "api: NOT ready"; fi
  if ready "$STATE/current.env" worker 3001; then echo "worker: ready"; else echo "worker: NOT ready"; fi
}

[[ $EUID -eq 0 ]] || die "run as root (sudo /usr/local/sbin/zaroorat-deploy)"

case "${1:-}" in
  deploy)
    [[ $# -eq 4 ]] || die "usage: deploy <sha> <app-digest> <ops-digest>"
    deploy "$2" "$3" "$4"
    ;;
  rollback)
    [[ $# -eq 1 ]] || die "usage: rollback"
    rollback
    ;;
  status)
    [[ $# -eq 1 ]] || die "usage: status"
    status
    ;;
  *) die "usage: deploy <sha> <app-digest> <ops-digest> | rollback | status" ;;
esac
