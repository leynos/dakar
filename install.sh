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

bun install -g "$script_dir"

printf '%s\n' "Installed dakar-review."
printf '%s\n' 'If your shell cannot find it, add Bun global bin to PATH:'
printf '%s\n' '  export PATH="$(bun pm bin -g):$PATH"'
