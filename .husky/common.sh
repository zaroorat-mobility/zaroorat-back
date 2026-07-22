#!/usr/bin/env sh
set -e

printf "\n🚀 \033[1;34mZaroorat Backend Checks\033[0m\n"

# Verify Node Version.
# Compares the MAJOR version only, so a teammate on a newer patch/minor
# (e.g. 26.4.1 vs 26.4.0) is not blocked from committing.
if [ -f .nvmrc ]; then
  EXPECTED_NODE=$(tr -d ' \n\r' < .nvmrc | sed 's/^v//')
  CURRENT_NODE=$(node -v | sed 's/^v//')

  EXPECTED_MAJOR=${EXPECTED_NODE%%.*}
  CURRENT_MAJOR=${CURRENT_NODE%%.*}

  if [ "$CURRENT_MAJOR" != "$EXPECTED_MAJOR" ]; then
    printf "\033[31m✖ Error: Node major version mismatch.\033[0m\n"
    printf "Expected: v%s.x (from .nvmrc: v%s)\n" "$EXPECTED_MAJOR" "$EXPECTED_NODE"
    printf "Current : v%s\n" "$CURRENT_NODE"
    printf "Please run 'nvm use' or update your node version.\n\n"
    exit 1
  fi
fi

# Verify Package Manager if running through a package manager script
if [ -n "$npm_config_user_agent" ]; then
  case "$npm_config_user_agent" in
    *npm*) ;;
    *) 
      printf "\033[31m✖ Error: Only npm is allowed. Please do not use yarn or pnpm.\033[0m\n"
      exit 1
      ;;
  esac
fi
