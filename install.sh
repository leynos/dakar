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

if ! command -v odw >/dev/null 2>&1; then
  printf '%s\n' "install.sh: odw is required but was not found on PATH" >&2
  printf '%s\n' "install.sh: install the ODW CLI (open-dynamic-workflows) and ensure 'odw' is on PATH before running Dakar" >&2
  exit 127
fi

# Remove any prior global Dakar install so a re-run starts from a clean state.
# bun remove updates the global package.json and shared bun.lock atomically and
# leaves other global packages untouched; ignore its failure when Dakar is not
# currently installed.
bun remove -g dakar >/dev/null 2>&1 || true

bun install -g "$script_dir"

printf '%s\n' "Installed dakar-review."
printf '%s\n' 'If your shell cannot find it, add Bun global bin to PATH:'
printf '%s\n' '  export PATH="$(bun pm bin -g):$PATH"'
