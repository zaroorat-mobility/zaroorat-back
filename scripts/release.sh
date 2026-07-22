#!/usr/bin/env bash
#
# Cut a release tag. Pushing the tag triggers .github/workflows/release.yml,
# which creates the GitHub Release; publishing that release triggers the
# production deploy. This script only bumps and tags — it never deploys.
#
#   ./scripts/release.sh patch     # 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor     # 1.0.0 -> 1.1.0
#   ./scripts/release.sh major     # 1.0.0 -> 2.0.0
#   ./scripts/release.sh 1.4.2     # explicit version

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BUMP="${1:-}"
if [[ -z "$BUMP" ]]; then
  echo "Usage: $0 <major|minor|patch|X.Y.Z>" >&2
  exit 1
fi

MAIN_BRANCH="main"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$CURRENT_BRANCH" != "$MAIN_BRANCH" ]]; then
  echo "Error: releases are cut from $MAIN_BRANCH (currently on $CURRENT_BRANCH)." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

echo "Fetching..."
git fetch --tags origin "$MAIN_BRANCH"

if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$MAIN_BRANCH")" ]]; then
  echo "Error: local $MAIN_BRANCH differs from origin/$MAIN_BRANCH. Pull or push first." >&2
  exit 1
fi

# Run the same gates CI runs, so a red build is caught before the tag exists.
# A tag that fails CI has to be deleted from every clone that fetched it.
echo "Verifying..."
npm run lint
npm run typecheck
npm test
npm run build

# `npm version` writes package.json, commits, and creates an annotated tag.
# It refuses to run on a dirty tree, which we already checked above.
echo "Bumping version ($BUMP)..."
NEW_VERSION="$(npm version "$BUMP" --message "chore(release): v%s")"

echo
echo "Created $NEW_VERSION"
echo "Review it, then push with:"
echo
echo "    git push origin $MAIN_BRANCH --follow-tags"
echo
echo "That triggers release.yml, which opens the GitHub Release."
echo "Publishing the release triggers the production deploy."
