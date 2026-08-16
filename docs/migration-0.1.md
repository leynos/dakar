# Migration guide: 0.1 installation

This signpost records the installation changes for Dakar 0.1.

## Use the canonical installer

Direct `bun install -g` installation is no longer supported. Install from a
Dakar checkout with:

```bash
./install.sh
```

The installer requires Node and npm on `PATH`, in addition to Bun and the ODW
CLI. It restores Dakar's locked dependencies in the checkout before asking
Bun to link that checkout globally. This order is required because the global
command links back to the checkout while Node resolves its runtime
dependencies there.

## Installer lock behaviour

The installer owns an `installer lock` named `.dakar-install.lock` under Bun's
configured global installation root. Separate checkouts using the same Bun
installation therefore share one lock. The installer acquires the lock before
restoring dependencies and keeps it through both global mutations, from
`bun remove -g dakar` through `bun install -g "$script_dir"`. Only the
installer that acquired the lock removes it; an installer waiting for another
owner never removes that owner's lock.

Waiting is bounded. The default `timeout` is 300 seconds. Tests and automation
may set `DAKAR_INSTALL_LOCK_WAIT_SECONDS` to a positive base-10 integer without
a leading zero. The value is validated before lock acquisition. While waiting,
the installer emits an immediate stderr diagnostic and periodic updates with
the stable operation, lock state, and elapsed time. If the limit expires,
`install.sh` exits non-zero and emits a diagnostic containing
`operation=global-install`, `lock=timeout`, the elapsed time, and the exact
`lock path`, together with manual-recovery guidance. It does not reclaim an
existing lock automatically. HUP, INT, and TERM are handled during waiting and
the locked installation phase, with cleanup limited to a lock acquired by the
current installer.

## Diagnose a stale lock safely

A `timeout` does not by itself prove that an installer lock is stale. First
inspect the exact `lock path` from the diagnostic and confirm that no installer
process is active. Check the process's terminal, service, or automation runner
as appropriate, and allow an active installation to finish or terminate
cleanly. Only after confirming that no installer process remains may an
operator remove that exact reported lock directory and retry `./install.sh`.

Never remove a lock while another installer may still be restoring dependencies
or mutating Bun's global state: doing so can reintroduce the race the installer
lock prevents. If an installer exits unexpectedly, repeat the same process—
confirm no installer is active, verify the reported path, and remove only that
exact directory.
