#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "${1:-}" in
  "" )
    ;;
  -h|--help )
    printf '%s\n' "Usage: ./install.sh"
    printf '%s\n' "Install dakar-review globally with Bun."
    exit 0
    ;;
  * )
    printf '%s\n' "install.sh: unexpected argument: $1" >&2
    printf '%s\n' "usage: ./install.sh" >&2
    exit 2
    ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' "install.sh: bun is required but was not found on PATH" >&2
  exit 127
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "install.sh: node is required but was not found on PATH" >&2
  exit 127
fi

bun_home=${BUN_INSTALL:-"$HOME/.bun"}
bun_global_dir=$bun_home/install/global
bun_global_manifest=$bun_global_dir/package.json
bun_global_lock=$bun_global_dir/bun.lock

if [ -f "$bun_global_manifest" ]; then
  node - "$bun_global_manifest" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')

const manifestPath = process.argv[2]
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.dependencies && Object.prototype.hasOwnProperty.call(manifest.dependencies, 'dakar')) {
  delete manifest.dependencies.dakar
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
NODE
fi

if [ -f "$bun_global_lock" ] && grep -q '"dakar"' "$bun_global_lock"; then
  rm -f "$bun_global_lock"
fi

bun install -g "$script_dir"

printf '%s\n' "Installed dakar-review."
printf '%s\n' 'If your shell cannot find it, add Bun global bin to PATH:'
printf '%s\n' '  export PATH="$(bun pm bin -g):$PATH"'
