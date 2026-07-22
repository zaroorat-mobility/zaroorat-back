#!/usr/bin/env sh
set -e

printf "\n🚀 \033[1;34mZaroorat Backend Checks\033[0m\n"

# Verify Node Version
if [ -f .nvmrc ]; then
  EXPECTED_NODE=$(cat .nvmrc | tr -d 'v\n\r')
  CURRENT_NODE=$(node -v | tr -d 'v\n\r')
  
  # Basic prefix check (e.g., matching '26.4.0')
  if [ "$CURRENT_NODE" != "$EXPECTED_NODE" ]; then
    printf "\033[31m✖ Error: Node version mismatch.\033[0m\n"
    printf "Expected: v%s (from .nvmrc)\n" "$EXPECTED_NODE"
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
