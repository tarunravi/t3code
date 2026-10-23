import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { CommandId, EventId, MessageId, NodeId, ProviderSessionId, ProviderThreadId, ProviderTurnId, RunAttemptId, RunId, TurnItemId } from "@t3tools/contracts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";


const isScheduledTaskError = Schema.is(ScheduledTaskError);

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);


it.effect.each(["eligible", "production-idle", "production-stale", "stale-concurrent", "stale-repeat-recreated", "stale-wrong-identity", "stale-wrong-error-owner", "stale-other-live-session", "stale-live-session", "stale-missing-liveness", "stale-no-session", "stale-running", "stale-tool", "stale-child", "stale-input", "stale-stop", "stale-frozen", "stale-restart-pending", "stale-nontransient", "stale-quota", "stale-permission", "stale-refusal", "stale-no-start-event", "stale-queued", "stale-late-stop", "stale-late-freeze", "stale-late-config", "stale-late-identity", "stale-late-tool", "stale-late-live", "unknown", "oversized", "late-stop", "frozen", "ordinary", "manual"] as const)(
  "gates opted-in scheduled recovery atomically while preserving %s behavior", (scenario) =>
  Effect.gen(function* () {
    const nowMs = Date.UTC(2026, 9, 23, 12);
    yield* TestClock.setTime(nowMs);
    const now = DateTime.makeUnsafe(nowMs);
    const startedAt = DateTime.makeUnsafe(nowMs - 180000);
    const completedAt = DateTime.makeUnsafe(nowMs - 120000);
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:scheduled-recovery");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make("provider-thread:scheduled-recovery");
    const providerTurnId = ProviderTurnId.make("turn:scheduled-recovery");
    const runId = RunId.make("run:scheduled-recovery");
    const attemptId = RunAttemptId.make("attempt:scheduled-recovery");
    const nodeId = NodeId.make("node:scheduled-recovery");
    const stale = scenario === "production-stale" || scenario.startsWith("stale-");
    const shouldRecover = ["production-stale", "stale-concurrent", "stale-repeat-recreated"].includes(scenario);
    const providerSessionId = ProviderSessionId.make("session:scheduled-stale");
    const terminalStatus = scenario === "stale-running" ? "running" as const : stale ? "failed" as const : "completed" as const;
    const modelSelection = { instanceId: providerInstanceId, model: "test", options: [{ id: "reasoningEffort", value: "max" }] };
    const realManagement = yield* ThreadManagementService.ThreadManagementService.pipe(Effect.provide(
      ThreadManagementService.layer.pipe(Layer.provide(Layer.mergeAll(ServerSettings.layerTest(), CommandReceiptStore.layer)))));
    yield* orchestrator.dispatch({ type: "thread.create", threadId, commandId: CommandId.make("create-policy-thread"),
      projectId: ProjectId.make("project:test"), title: "Policy thread", modelSelection,
      runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
      createdBy: "user", creationSource: "web" });
    const run = { id: runId, threadId, ordinal: 1, providerInstanceId, modelSelection, providerThreadId,
      userMessageId: MessageId.make("message:policy-source"), rootNodeId: nodeId, activeAttemptId: attemptId,
      status: scenario === "stale-queued" ? "queued" as const : terminalStatus, requestedAt: startedAt, startedAt: scenario === "stale-queued" ? null : startedAt, completedAt, checkpointId: null, contextHandoffId: null };
    const attempt = { id: attemptId, runId, attemptOrdinal: 1, rootNodeId: nodeId, providerInstanceId,
      providerThreadId, providerTurnId, reason: "initial" as const, status: scenario === "stale-queued" ? "pending" as const : terminalStatus, startedAt: scenario === "stale-queued" ? null : startedAt, completedAt };
    const events = [
      { type: "run.created", payload: run },
      { type: "run-attempt.created", payload: attempt },
      { type: "provider-thread.updated", payload: { id: providerThreadId, driver: "codex", providerInstanceId,
        providerSessionId: stale ? providerSessionId : null, appThreadId: threadId, ownerNodeId: null, nativeThreadRef: null,
        nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 1,
        handoffIds: [], forkedFrom: null, createdAt: startedAt, updatedAt: completedAt } },
      { type: "provider-turn.updated", payload: { id: providerTurnId, providerThreadId, nodeId,
        runAttemptId: attemptId, nativeTurnRef: null, ordinal: 1, status: terminalStatus, startedAt, completedAt } },
    ];
    for (const [index, event] of events.entries()) yield* projections.apply({ ...event,
      id: EventId.make(`event:policy:${index}`), threadId, occurredAt: now } as never);
    if (stale) yield* projections.apply({ id: EventId.make("session:stale"), type: "provider-session.updated", threadId, occurredAt: completedAt,
      payload: { id: providerSessionId, driver: "codex", providerInstanceId, status: "error", cwd: "/projects/test", model: "test", capabilities: CodexProviderCapabilitiesV2, createdAt: startedAt, updatedAt: completedAt, lastError: "Stream disconnected" } } as never);
    const failureItem = { id: TurnItemId.make("item:transport-failure"), nativeItemRef: null, parentItemId: null, title: null, updatedAt: completedAt, threadId, runId, providerThreadId: scenario === "stale-wrong-error-owner" ? ProviderThreadId.make("provider-thread:wrong-error") : providerThreadId, providerTurnId, nodeId, ordinal: 1, type: "error" as const, status: "failed" as const,
            startedAt: completedAt, completedAt, failure: { class: scenario === "stale-quota" ? "usage_limit" as const : scenario === "stale-permission" ? "permission_error" as const : "transport_error" as const, code: scenario === "stale-refusal" ? "refusal" : "responseStreamDisconnected", retryable: scenario !== "stale-nontransient", message: "Disconnected" } };
    if (stale || ["eligible", "production-idle", "late-stop", "oversized"].includes(scenario)) {
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: [
        ...(scenario === "stale-no-start-event" ? [] : [{ id: EventId.make("durable-attempt-start"), type: "run-attempt.created" as const, threadId, runId,
          occurredAt: startedAt, payload: { ...attempt, status: "running" as const, completedAt: null } }]),
        { id: EventId.make("durable-turn-end"), type: "provider-turn.updated", threadId, runId,
          occurredAt: completedAt, payload: { id: providerTurnId, providerThreadId, nodeId,
            runAttemptId: attemptId, nativeTurnRef: null, ordinal: 1, status: terminalStatus, startedAt, completedAt } },
        ...(stale ? [{ id: EventId.make("durable-transient-failure"), type: "turn-item.updated" as const, threadId, runId, occurredAt: completedAt,
          payload: failureItem }] : []),
        { id: EventId.make("durable-attempt-end"), type: "run-attempt.updated", threadId, runId,
          occurredAt: completedAt, payload: attempt },
        { id: EventId.make("durable-run-end"), type: "run.updated", threadId, runId,
          occurredAt: completedAt, payload: run },
      ] });
      if (scenario === "oversized") yield* sink.write({ events: [{
        id: EventId.make("oversize-history"), type: "thread.metadata-updated", threadId,
        occurredAt: now, payload: { ...(yield* projections.getThread(threadId)), title: "x".repeat(131073) },
      }] });
    }
    const schedule = { type: "interval", everyMs: 60000,
      ...(scenario === "ordinary" ? {} : { idleStallRecovery: { timeoutMs: 60000, cooldownMs: 0 } }) };
    yield* insertRow(sql, { id: "policy-task", next: DateTime.formatIso(now), enabled: 1,
      status: "never", scheduleJson: JSON.stringify(schedule) }, DateTime.formatIso(startedAt));
    yield* sql`UPDATE scheduled_tasks SET thread_id = ${threadId} WHERE task_id = 'policy-task'`;
    if (["frozen", "stale-frozen"].includes(scenario)) yield* orchestrator.dispatch({ type: "thread.metadata.update", threadId,
      commandId: CommandId.make("freeze-before-policy"), preservationOnly: true });
    const activeTool = projections.apply({ id: EventId.make("tool:observation"), type: "turn-item.updated", threadId, occurredAt: now,
      payload: { id: TurnItemId.make("tool:active"), threadId, runId, nodeId, providerThreadId, providerTurnId,
        nativeItemRef: null, parentItemId: null, ordinal: 9, status: "running", title: null,
        startedAt, completedAt: null, updatedAt: now, type: "command_execution", input: "bounded test tool" } });
    if (scenario === "stale-stop") yield* orchestrator.dispatch({ type: "thread.stop", threadId, commandId: CommandId.make("stale-stop") });
    if (scenario === "stale-wrong-identity") yield* sql`UPDATE orchestration_v2_projection_run_attempts SET payload_json = json_set(payload_json, '$.providerThreadId', 'provider-thread:wrong') WHERE attempt_id = ${attemptId}`;
    if (scenario === "stale-other-live-session") yield* projections.apply({ id: EventId.make("session:other-live"), type: "provider-session.updated", threadId, occurredAt: now,
      payload: { id: ProviderSessionId.make("session:other-live"), driver: ProviderDriverKind.make("codex"), providerInstanceId, status: "running", cwd: "/projects/test", model: "test", capabilities: CodexProviderCapabilitiesV2, createdAt: startedAt, updatedAt: now, lastError: null } });
    if (scenario === "stale-no-session") yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = ${providerSessionId}`;
    if (scenario === "stale-input") yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, payload_json) VALUES ('request:wait', ${threadId}, ${nodeId}, ${providerTurnId}, 'user_input', 'pending', ${DateTime.formatIso(now)}, '{}')`;
    if (scenario === "stale-tool") yield* activeTool;
    if (scenario === "stale-child") yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json) VALUES ('child:active', ${threadId}, ${nodeId}, 'codex', 'provider', 'running', ${DateTime.formatIso(now)}, '{}')`;
    if (scenario === "stale-restart-pending") yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at) VALUES ('restart:pending', 'restart:command', ${threadId}, 'provider-runtime.continue', '{}', 'pending', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)})`;
    let tick: Effect.Effect<void> = Effect.die("Scheduler registration missing");
    const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
      name: string, work: Effect.Effect<void, E, R>,
    ) => Effect.context<R>().pipe(Effect.map((context) => {
      if (name === "scheduled-tasks") tick = work.pipe(Effect.provideContext(context), Effect.orDie);
    }));
    const { isProviderSessionLive, ...withoutLiveness } = realManagement;
    let sent = 0;
    let sentToBoundary = false;
    const layer = ScheduledTaskService.layer.pipe(Layer.provide(Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(Scheduler.Scheduler)({ register }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false) }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(ThreadManagementService.ThreadManagementService, { ...withoutLiveness,
        ...(scenario === "stale-missing-liveness" ? {} : { isProviderSessionLive: (id: ProviderSessionId) => {
          assert.equal(id, providerSessionId);
          return scenario === "stale-live-session" || (scenario === "stale-late-live" && sentToBoundary)
            ? Effect.succeed(true) : isProviderSessionLive!(id);
        } }), sendToThread: (input) => Effect.gen(function* () {
        sentToBoundary = true;
        assert.isFalse("modelSelection" in input);
        if (["late-stop", "stale-late-stop"].includes(scenario)) yield* orchestrator.dispatch({ type: "thread.stop", threadId,
          commandId: CommandId.make("stop-after-observation") });
        if (scenario === "stale-late-freeze") yield* orchestrator.dispatch({ type: "thread.metadata.update", threadId, commandId: CommandId.make("late-freeze"), preservationOnly: true });
        if (scenario === "stale-late-config") yield* sql`UPDATE scheduled_tasks SET prompt = 'Changed execution prompt' WHERE task_id = 'policy-task'`;
        if (scenario === "stale-late-identity") yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'attempt:superseded') WHERE run_id = ${runId}`;
        if (scenario === "stale-late-tool") yield* activeTool;
        const result = yield* realManagement.sendToThread(input);
        sent++;
        return result;
      }).pipe(Effect.orDie) }),
    )));
    const exercise = Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      if (scenario === "manual") yield* service.runNow({ id: ScheduledTaskId.make("policy-task") });
      else if (scenario === "stale-concurrent") {
        const firstTick = tick;
        yield* Effect.gen(function* () {
          yield* ScheduledTaskService.ScheduledTaskService;
          yield* Effect.all([firstTick, tick], { concurrency: "unbounded", discard: true });
        }).pipe(Effect.provide(Layer.fresh(layer)));
      } else {
        yield* tick;
        if (scenario === "production-idle" || shouldRecover) {
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DateTime.formatIso(now)} WHERE task_id = 'policy-task'`;
          yield* tick;
          if (scenario === "stale-repeat-recreated") yield* Effect.gen(function* () {
            // Simulate an earlier projection after restart; the durable command receipt must still win.
            yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id != ${runId}`;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({ events: [{ id: EventId.make("duplicate-failure-after-restart"), type: "turn-item.updated", threadId, runId, occurredAt: completedAt, payload: failureItem }] });
            sentToBoundary = false;
            yield* ScheduledTaskService.ScheduledTaskService;
            yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DateTime.formatIso(now)} WHERE task_id = 'policy-task'`;
            yield* tick;
            assert.isFalse(sentToBoundary);
          }).pipe(Effect.provide(Layer.fresh(layer)));
        }
      }
      assert.equal(sent, (shouldRecover || ["eligible", "production-idle", "ordinary", "manual"].includes(scenario)) ? 1 : 0);
      if (shouldRecover && scenario !== "stale-repeat-recreated") {
        const queued = yield* sql<{ payload_json: string }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id != ${runId}`;
        assert.lengthOf(queued, 1);
        assert.deepEqual(JSON.parse(queued[0]!.payload_json).modelSelection, modelSelection);
      }
      const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM orchestration_command_receipts
        WHERE command_id GLOB 'scheduled-task:policy-task:idle-stall:*' AND status = 'accepted'`;
      assert.equal(rows[0]?.count, (shouldRecover || ["eligible", "production-idle"].includes(scenario)) ? 1 : 0);
    }).pipe(Effect.provide(layer));
    yield* exercise;
  }).pipe(Effect.provide((() => {
    const db = SqlitePersistence.layerMemory;
    const registry = ProviderAdapterRegistry.layerFromAdapters([{ instanceId: ProviderInstanceId.make("codex"),
      driver: "codex", getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Provider execution forbidden in scheduler tests") } as never]);
    return Layer.mergeAll(db, ProjectionStore.layer.pipe(Layer.provide(db)),
      ProviderReplayHarness.layerWithRegistry({ name: "idle-stall-integration" }, registry,
        { databaseLayer: db, runEffectWorker: false }));
  })())),
);
