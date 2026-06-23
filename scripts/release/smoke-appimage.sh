#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?AppImage path required}"
glibc="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
if [[ "$(printf '%s\n2.28\n' "$glibc" | sort -V | head -1)" != "2.28" ]]; then
  echo "Host glibc $glibc is older than required 2.28" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

(
  cd "$workdir"
  timeout 120 "$artifact" --appimage-extract >/dev/null
)

test -x "$workdir/squashfs-root/AppRun"
test -x "$workdir/squashfs-root/ai-config-hub"
test -s "$workdir/squashfs-root/resources/app.asar"
