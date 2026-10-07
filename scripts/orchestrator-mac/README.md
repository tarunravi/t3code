# T3 Code macOS build

Builds this fork as `T3 Code`: bundle id `com.t3tools.t3code.orchestrator`, desktop profile `t3code-pr-2829`, backend home `~/.t3-pr-2829`, auto-update off. `overlay.patch` applies that identity in a scratch worktree, so the source tree keeps upstream's identity.

## Build

Requires Node 24.13 or newer, pnpm 11, Xcode command-line tools, and a code-signing identity.

```sh
security find-identity -v -p codesigning   # pick the identity's SHA-1
T3_ORCH=1 T3_SIGNING_IDENTITY=<sha1> scripts/orchestrator-mac/build.sh ~/t3-orchestrator-build
```

The signed app lands in `<output-dir>/signed.noindex/T3 Code.app`, with `build.log` and `BUILD-INFO.txt` beside it. The script refuses ad hoc signing and a dirty checkout. It finishes by running `verify-signature.sh`, which fails unless the designated requirement names the bundle id and certificate instead of a cdhash.

## Why the signing identity matters

macOS stores each Accessibility and Screen Recording grant with the designated requirement of the build that was granted. An ad hoc signature's requirement is its cdhash, which changes on every build. After a rebuild, `tccd` logs `Failed to match existing code requirement` and denies access while System Settings still shows the toggle on.

- Work Mac: sign with the approved Developer ID identity. Its requirement is `identifier "com.t3tools.t3code.orchestrator" and anchor apple generic … certificate leaf[subject.OU] = "<TeamID>"`, which stays the same across rebuilds.
- Personal Mac without a Developer ID: run `create-local-signing-identity.sh` once, then build with the SHA-1 it prints. Its requirement is `identifier "…" and certificate leaf = H"<sha1>"`, which stays the same while you keep that certificate. Do not use a self-signed identity on a Mac whose policy, such as Santa, requires an approved team.

## Install

1. Start the reinstall flow from inside T3 Code. The detached hand-off records active threads, then quits the app after the initiating turn finishes.
2. Use `scripts/orchestrator-mac/reinstall.sh` to migrate an existing `/Applications/T3 Code (Orchestrator).app` into `/Applications/T3 Code.app`. The detached hand-off keeps the prior app under the backup's `old/` directory for rollback. If both paths already exist, move one aside before running the installer.
3. Run `scripts/orchestrator-mac/verify-signature.sh "/Applications/T3 Code.app"`.
4. The first time you switch an app to stable signing, or when stale rows appear, run `scripts/orchestrator-mac/reset-tcc-grants.sh` (dry run) and then `reset-tcc-grants.sh --apply`. Rows for apps no longer on disk cannot be reset by `tccutil`; remove them with the − button in System Settings.
5. Launch the app and grant Accessibility and Screen Recording again when asked. Later rebuilds signed with the same identity keep these grants.

## Reinstall from inside T3

Quitting T3 stops every agent in it, so an agent can't swap the app directly. `reinstall.sh` verifies the new build, records the active threads, and hands the swap to a one-shot launchd job outside T3's process tree. The job backs up the databases, quits T3, installs the new app, relaunches it, and starts a post-install thread. If a step after the swap fails, it restores the old app (and the database backups, if the new app had launched).

```sh
scripts/orchestrator-mac/reinstall.sh --dry-run --exclude-thread <calling thread id>   # rehearse; changes nothing
scripts/orchestrator-mac/reinstall.sh --exclude-thread <calling thread id>             # hand off
scripts/orchestrator-mac/reinstall.sh --rollback ~/Backups/t3-reinstall-<ts>           # detached rollback
scripts/orchestrator-mac/reinstall.sh --cleanup ~/Backups/t3-reinstall-<ts>            # after verification
```

`t3-rpc.mjs` is its Node helper for the running server: `health`, `active-threads`, `launch`, and `resume`. The full flow is the `install-new-t3` skill in Tarun's brain vault.
