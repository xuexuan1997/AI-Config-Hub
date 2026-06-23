#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?AppImage path required}"
glibc="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
if [[ "$(printf '%s\n2.28\n' "$glibc" | sort -V | head -1)" != "2.28" ]]; then
  echo "Host glibc $glibc is older than required 2.28" >&2
  exit 1
fi

AI_CONFIG_HUB_E2E_ROOT="$(mktemp -d)" \
AI_CONFIG_HUB_USER_DATA="$(mktemp -d)" \
ELECTRON_RUN_AS_NODE=1 \
timeout 60 "$artifact" --appimage-extract-and-run -e "console.log(process.versions.electron)" >/tmp/ai-config-hub-smoke.txt
test -s /tmp/ai-config-hub-smoke.txt
