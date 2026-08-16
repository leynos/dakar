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

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "install.sh: npm is required but was not found on PATH" >&2
  exit 127
fi

if ! command -v odw >/dev/null 2>&1; then
  printf '%s\n' "install.sh: odw is required but was not found on PATH" >&2
  printf '%s\n' "install.sh: install the ODW CLI (open-dynamic-workflows) and ensure 'odw' is on PATH before running Dakar" >&2
  exit 127
fi

# Bun's global installation root owns this lock because separate checkouts can
# mutate its global package record concurrently. The default five-minute limit
# avoids waiting forever; automation may set DAKAR_INSTALL_LOCK_WAIT_SECONDS.
lock_wait_limit=${DAKAR_INSTALL_LOCK_WAIT_SECONDS:-300}

case "$lock_wait_limit" in
  '' | 0* | *[!0-9]* )
    printf '%s\n' 'install.sh: DAKAR_INSTALL_LOCK_WAIT_SECONDS must be a positive base-10 integer without a leading zero' >&2
    exit 2
    ;;
  * )
    ;;
esac

lock_acquired=false

release_install_lock() {
  status=$?
  if [ "$lock_acquired" = true ]; then
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  trap - 0
  exit "$status"
}

trap release_install_lock 0
trap 'exit 1' HUP INT TERM

if ! bun_cache_dir=$(bun pm cache); then
  printf '%s\n' 'install.sh: operation=global-install lock=acquisition-failed elapsed=0s path=unknown; cannot determine Bun global installation root' >&2
  exit 1
fi

lock_dir=$(dirname "$bun_cache_dir")/.dakar-install.lock
lock_wait_started=$(date +%s)
next_lock_diagnostic=0

while ! mkdir "$lock_dir" 2>/dev/null; do
  lock_wait_now=$(date +%s)
  lock_wait_elapsed=$((lock_wait_now - lock_wait_started))

  if [ ! -d "$lock_dir" ]; then
    printf '%s\n' "install.sh: operation=global-install lock=acquisition-failed elapsed=${lock_wait_elapsed}s path=$lock_dir; cannot create lock directory" >&2
    exit 1
  fi

  if [ "$lock_wait_elapsed" -ge "$lock_wait_limit" ]; then
    printf '%s\n' "install.sh: operation=global-install lock=timeout elapsed=${lock_wait_elapsed}s path=$lock_dir; confirm no installer process is active, then remove only this exact stale lock directory before retrying" >&2
    exit 1
  fi

  if [ "$lock_wait_elapsed" -ge "$next_lock_diagnostic" ]; then
    printf '%s\n' "install.sh: operation=global-install lock=waiting elapsed=${lock_wait_elapsed}s path=$lock_dir; another Dakar installation may be active" >&2
    next_lock_diagnostic=$((lock_wait_elapsed + 30))
  fi

  sleep 1
done

lock_acquired=true

# Bun links local-package executables back into their source checkout. Node then
# resolves runtime imports from that checkout rather than Bun's global module
# tree, so restore the exact locked dependencies beside Dakar first. Install the
# complete lockfile so running the installer from a development checkout does
# not leave its required tooling pruned.
npm ci --include=dev --ignore-scripts --no-audit --no-fund --prefix "$script_dir"

# Remove any prior global Dakar install so a re-run starts from a clean state.
# bun remove updates the global package.json and shared bun.lock atomically and
# leaves other global packages untouched; ignore its failure when Dakar is not
# currently installed.
bun remove -g dakar >/dev/null 2>&1 || true

bun install -g "$script_dir"

printf '%s\n' "Installed dakar-review."
printf '%s\n' 'If your shell cannot find it, add Bun global bin to PATH:'
printf '%s\n' '  export PATH="$(bun pm bin -g):$PATH"'
