# Slingshot

A desktop and web interface for a local [Slingshot](https://github.com/scaleapi/slingshot) server. This fork keeps T3 Code's polished thread UI while removing the other active harness integrations.

## What works

- Slingshot is the only selectable provider.
- Models and agents are discovered from the local Sling server.
- Streaming text, shell tools, file tools, permission prompts, and `task` subagents render in the thread timeline.
- Threads resume through Sling's persisted session IDs.
- GPT, Claude, and other models exposed by Sling appear in the model picker.

Internally, the adapter retains its `opencode` identifier because Sling implements the OpenCode HTTP/SSE protocol. That name is a compatibility detail, not a second harness.

## Run locally

Requirements: Node.js 24.13.1, pnpm 11.10, and Slingshot 0.2.1 or newer.

```bash
pnpm install
pnpm dev -- --browser
```

Fresh settings launch `sling serve` automatically. To use an existing server instead, set its URL in Settings; `http://127.0.0.1:4096` is Sling's default. Development state stays in this checkout's `.t3` directory.

## Build and test

```bash
pnpm typecheck
pnpm test
pnpm build:desktop
```

## Attribution

This project is a Slingshot-specific fork of [T3 Code](https://github.com/pingdotgg/t3code). The original project and this fork are licensed under the MIT License.
