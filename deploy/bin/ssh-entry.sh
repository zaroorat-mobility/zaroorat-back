#!/usr/bin/env bash
# Forced command for the GitHub Actions DEV deploy key.
#
# Installed root-owned, outside the git checkout:
#   install -o root -g root -m 0755 /opt/zaroorat/src/deploy/bin/ssh-entry.sh /usr/local/sbin/zaroorat-ssh-entry
# ~deploy/.ssh/authorized_keys:
#   restrict,command="/usr/local/sbin/zaroorat-ssh-entry" ssh-ed25519 AAAA... gha-dev-deploy
#
# The deploy user is NOT in the docker group. Its only privilege is one sudo rule:
#   deploy ALL=(root) NOPASSWD: /usr/local/sbin/zaroorat-deploy
# Anything that is not exactly one of the three commands below is refused.
set -euo pipefail

cmd=${SSH_ORIGINAL_COMMAND:-}

if [[ $cmd =~ ^deploy\ ([0-9a-f]{40})\ (sha256:[0-9a-f]{64})\ (sha256:[0-9a-f]{64})$ ]]; then
  exec sudo -n /usr/local/sbin/zaroorat-deploy deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
elif [[ $cmd == status || $cmd == rollback ]]; then
  exec sudo -n /usr/local/sbin/zaroorat-deploy "$cmd"
fi

echo "denied: allowed commands are 'deploy <40-hex sha> <sha256 app digest> <sha256 ops digest>', 'status', 'rollback'" >&2
exit 1
