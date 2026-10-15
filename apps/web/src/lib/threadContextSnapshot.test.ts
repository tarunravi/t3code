import {
  COMPOSER_CONTEXT_THREAD_SNAPSHOT_MAX_CHARS,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildThreadContextTranscript,
  resolveThreadContextRecords,
  type ThreadSnapshotMessage,
} from "./threadContextSnapshot";

const isThreadContextRecord = Schema.is(ThreadContextRecord);
const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const ref = (environmentId: EnvironmentId, threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});
const message = (
  role: ThreadSnapshotMessage["role"],
  text: string,
  streaming = false,
): ThreadSnapshotMessage => ({ role, text, streaming });

describe("buildThreadContextTranscript", () => {
  it("keeps user and assistant text, oldest first, and marks streaming replies", () => {
    expect(
      buildThreadContextTranscript([
        message("system", "hidden"),
        message("user", "Fix login"),
        message("assistant", "  "),
        message("assistant", "Working on it", true),
      ]),
    ).toBe("[user] Fix login\n\n[assistant, in progress] Working on it");
  });

  it("keeps the newest messages within the contract cap and notes what was dropped", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message("assistant", `${index}:`.padEnd(5_000, "x")),
    );
    const transcript = buildThreadContextTranscript(messages);
    expect(transcript.length).toBeLessThanOrEqual(COMPOSER_CONTEXT_THREAD_SNAPSHOT_MAX_CHARS);
    expect(transcript).toMatch(/^\(\d+ earlier messages omitted\)/);
    expect(transcript).toContain("[assistant] 39:");
    expect(transcript).not.toContain("[assistant] 0:");
    expect(transcript).toContain("… (truncated)");
  });

  it("says so when there is nothing to show", () => {
    expect(buildThreadContextTranscript([])).toBe("(no messages)");
  });
});

describe("resolveThreadContextRecords", () => {
  const base = {
    destinationEnvironmentId: local,
    readTitle: (target: ScopedThreadRef) => `Title ${target.threadId}`,
    readEnvironmentLabel: (environmentId: EnvironmentId) =>
      environmentId === remote ? "homeserver" : null,
    now: () => new Date("2026-10-15T12:00:00.000Z"),
  };

  it("attaches same-environment threads by identity without fetching", async () => {
    const fetchMessages = vi.fn(async () => []);
    const result = await resolveThreadContextRecords({
      ...base,
      refs: [ref(local, "a")],
      fetchMessages,
    });
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, records: [{ threadId: "a", title: "Title a" }] });
    expect(result.ok && result.records[0]?.snapshot).toBeUndefined();
  });

  it("attaches a foreign thread with a schema-valid inline snapshot", async () => {
    const result = await resolveThreadContextRecords({
      ...base,
      refs: [ref(remote, "b")],
      fetchMessages: async () => [message("user", "hello from afar")],
    });
    if (!result.ok) throw new Error("expected success");
    const record = result.records[0]!;
    expect(record.environmentId).toBe(remote);
    expect(record.snapshot).toEqual({
      environmentLabel: "homeserver",
      capturedAt: "2026-10-15T12:00:00.000Z",
      transcript: "[user] hello from afar",
    });
    expect(isThreadContextRecord(record)).toBe(true);
  });

  it("fails the whole attachment when a foreign environment is unreachable", async () => {
    const result = await resolveThreadContextRecords({
      ...base,
      refs: [ref(local, "a"), ref(remote, "b")],
      fetchMessages: async () => null,
    });
    expect(result).toEqual({ ok: false, failedTitle: "Title b" });
  });
});
