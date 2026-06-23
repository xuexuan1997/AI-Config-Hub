#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?AppImage path required}"
output="${2:-release/linux-x64/elf-compatibility.json}"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

"$artifact" --appimage-extract >/dev/null
mv squashfs-root "$workdir/root"

records="$workdir/records.jsonl"
: > "$records"
while IFS= read -r -d '' file; do
  if file "$file" | grep -q 'ELF'; then
    max_symbol="$(objdump -T "$file" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1 || true)"
    if [[ -n "$max_symbol" && "$(printf '%s\nGLIBC_2.28\n' "$max_symbol" | sort -V | tail -1)" != "GLIBC_2.28" ]]; then
      echo "Unsupported glibc symbol $max_symbol in $file" >&2
      exit 1
    fi
    printf '{"path":%q,"maxGlibc":%q}\n' "${file#"$workdir/root/"}" "${max_symbol:-none}" >> "$records"
  fi
done < <(find "$workdir/root" -type f -print0)

mkdir -p "$(dirname "$output")"
printf '{"schemaVersion":1,"glibcBaseline":"2.28","records":[' > "$output"
paste -sd, "$records" >> "$output"
printf ']}\n' >> "$output"
