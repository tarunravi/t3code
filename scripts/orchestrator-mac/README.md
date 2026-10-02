# T3 Code (Orchestrator) macOS build

Builds this fork as `T3 Code (Orchestrator)`: bundle id `com.t3tools.t3code.orchestrator`, desktop profile `t3code-pr-2829`, backend home `~/.t3-pr-2829`, auto-update off. `overlay.patch` applies that identity in a scratch worktree, so the source tree keeps upstream's identity.

## Build

Requires Node 24.13 or newer, pnpm 11, Xcode command-line tools, and a code-signing identity.

```sh
security find-identity -v -p codesigning   # pick the identity's SHA-1
T3_SIGNING_IDENTITY=<sha1> scripts/orchestrator-mac/build.sh ~/t3-orchestrator-build
```

The signed app lands in `<output-dir>/signed.noindex/T3 Code (Orchestrator).app`, with `build.log` and `BUILD-INFO.txt` beside it. The script refuses ad hoc signing and a dirty checkout. It finishes by running `verify-signature.sh`, which fails unless the designated requirement names the bundle id and certificate instead of a cdhash.

## Why the signing identity matters

macOS stores each Accessibility and Screen Recording grant with the designated requirement of the build that was granted. An ad hoc signature's requirement is its cdhash, which changes on every build. After a rebuild, `tccd` logs `Failed to match existing code requirement` and denies access while System Settings still shows the toggle on.

- Work Mac: sign with the approved Developer ID identity. Its requirement is `identifier "com.t3tools.t3code.orchestrator" and anchor apple generic … certificate leaf[subject.OU] = "<TeamID>"`, which stays the same across rebuilds.
- Personal Mac without a Developer ID: run `create-local-signing-identity.sh` once, then build with the SHA-1 it prints. Its requirement is `identifier "…" and certificate leaf = H"<sha1>"`, which stays the same while you keep that certificate. Do not use a self-signed identity on a Mac whose policy, such as Santa, requires an approved team.

## Install

1. Quit T3 Code. Agents running inside it stop.
2. Move the old app out of `/Applications` (keep it for rollback), then `ditto "<output-dir>/signed.noindex/T3 Code (Orchestrator).app" "/Applications/T3 Code (Orchestrator).app"`.
3. Run `scripts/orchestrator-mac/verify-signature.sh "/Applications/T3 Code (Orchestrator).app"`.
4. The first time you switch an app to stable signing, or when stale rows appear, run `scripts/orchestrator-mac/reset-tcc-grants.sh` (dry run) and then `reset-tcc-grants.sh --apply`. Rows for apps no longer on disk cannot be reset by `tccutil`; remove them with the − button in System Settings.
5. Launch the app and grant Accessibility and Screen Recording again when asked. Later rebuilds signed with the same identity keep these grants.
