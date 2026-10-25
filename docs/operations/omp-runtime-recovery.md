# OMP continuation recovery

T3's OMP adapter verifies provider idleness after a terminal `agent_end`, a settled
`prompt_result`, or `session_settled`. A final assistant message alone does not
complete the run: background work may still wake it. No inactivity timer cancels
long jobs.

OMP 18.4.2 can coalesce recovery requested after a continuation yields onto that
same continuation, losing the next model call. The versioned patch in
[`packaging/omp/18.4.2-continuation.patch`](../../packaging/omp/18.4.2-continuation.patch)
fixes the scheduler in its owning runtime. It also stops incomplete-answer
recovery after three attempts and emits an error notice, which T3 records as a
failed run. Text already generated remains visible.

The patch targets upstream tag `v18.4.2`, commit
`4620bb8338e0ecace7ea237da9d5088d16068617`. Maintain changes in an OMP source
checkout; do not modify an installed bundle. Apply with `git am`, then run:

```sh
bun test packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts \
  packages/coding-agent/test/agent-session-unexpected-stop-guard.test.ts \
  packages/coding-agent/test/agent-session-concurrent.test.ts \
  packages/coding-agent/test/agent-session-steer-idle-drain.test.ts \
  packages/coding-agent/test/agent-session-retry-cap.test.ts \
  packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts \
  packages/coding-agent/test/rpc-session-settle.test.ts
```

The regression drives a context overflow, successful compaction, and a
thinking-only stop while the first continuation still owns the scheduler. The
original runtime loses the recovery call; the patch produces the final answer.
Generation and abort guards still apply when that recovery is admitted again.

## Context limits

Use the serving backend's limit for custom model metadata. On the affected GLM
deployment, `/health` reports `context_length: 262144`, while OMP's `models.yml`
advertises `contextWindow: 400000`. A rejected request reserved 32768 output
tokens on top of 229808 prompt tokens: 262576 total, 432 over the backend limit.

For that deployment, change only the matching custom model's `contextWindow` to
`262144`, retaining `maxTokens: 32768` and its other settings. Recheck the backend
limit when its configuration changes. OMP's default reserve is at least 15% of
the window: 39321 tokens at this limit, leaving a compaction threshold of 222823.
That already exceeds the required output reserve; no reserve algorithm change
is needed. Do not increase or restart the shared backend to match stale metadata.

## Rollout and existing runs

Ship both the T3 adapter change and the patched OMP build, and correct the model
metadata before creating replacement sessions. These source changes do not
repair existing in-memory sessions. Schedule installation when active sessions
can be preserved or drained; this patch does not require a backend restart.

For a stuck thread, first confirm its own provider has stopped streaming, has no
pending tools, prompts, compaction, queued input, or background jobs. Use T3's
per-thread stop controls for that idle session, then resume from verified work
with corrected metadata. After model repetition, prefer a concise handoff to a
fresh context. For a delivered benchmark, retain the artifacts and close the
stale session without rerunning it. Never repair status with direct database
writes or process-wide restarts.

Repetition recorded in native model messages is a separate generation failure.
The scheduler and completion fixes prevent silent lost recovery and stale status;
they do not establish or change the model's sampling or quantization behavior.
