import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  COMPOSER_CONTEXT_THREAD_SNAPSHOT_MAX_CHARS,
  type EnvironmentId,
  type OrchestrationV2ConversationMessage,
  type ScopedThreadRef,
  type ThreadContextRecord,
} from "@t3tools/contracts";

import { threadContextRecord } from "./composerContextRecords";

// Matches the per-item cap agents use when paging t3_thread_read history.
const SNAPSHOT_MESSAGE_MAX_CHARS = 4_000;

export type ThreadSnapshotMessage = Pick<
  OrchestrationV2ConversationMessage,
  "role" | "text" | "streaming"
>;

/** Newest messages that fit the snapshot cap, oldest first, with a note for what was dropped. */
export function buildThreadContextTranscript(
  messages: ReadonlyArray<ThreadSnapshotMessage>,
): string {
  const entries = messages.flatMap((message) => {
    const text = message.text.trim();
    if (message.role === "system" || text.length === 0) return [];
    const clipped =
      text.length > SNAPSHOT_MESSAGE_MAX_CHARS
        ? `${text.slice(0, SNAPSHOT_MESSAGE_MAX_CHARS)}… (truncated)`
        : text;
    return [`[${message.role}${message.streaming ? ", in progress" : ""}] ${clipped}`];
  });
  if (entries.length === 0) return "(no messages)";
  // Leave room for the omission note so the result always fits the contract cap.
  const budget = COMPOSER_CONTEXT_THREAD_SNAPSHOT_MAX_CHARS - 64;
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (used + entry.length + 2 > budget) break;
    kept.unshift(entry);
    used += entry.length + 2;
  }
  const omitted = entries.length - kept.length;
  return [...(omitted > 0 ? [`(${omitted} earlier messages omitted)`] : []), ...kept].join("\n\n");
}

export type ResolveThreadContextRecordsResult =
  | { readonly ok: true; readonly records: ReadonlyArray<ThreadContextRecord> }
  | { readonly ok: false; readonly failedTitle: string };

/**
 * Same-environment threads attach by identity. A thread from another environment is fetched
 * through the client's own connection and attached with its recent history inline, because the
 * receiving agent cannot read across servers. Any failed fetch fails the whole attachment so a
 * message never goes out with a reference the agent cannot resolve.
 */
export async function resolveThreadContextRecords(input: {
  readonly refs: ReadonlyArray<ScopedThreadRef>;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly readTitle: (ref: ScopedThreadRef) => string | null;
  readonly readEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly fetchMessages: (
    ref: ScopedThreadRef,
  ) => Promise<ReadonlyArray<ThreadSnapshotMessage> | null>;
  readonly now?: () => Date;
}): Promise<ResolveThreadContextRecordsResult> {
  const records: ThreadContextRecord[] = [];
  for (const ref of input.refs) {
    const title = input.readTitle(ref);
    if (title === null) continue;
    const record = threadContextRecord(ref, title);
    if (ref.environmentId === input.destinationEnvironmentId) {
      records.push(record);
      continue;
    }
    const messages = await input.fetchMessages(ref);
    if (messages === null) return { ok: false, failedTitle: record.title };
    const environmentLabel = (
      input.readEnvironmentLabel(ref.environmentId) ?? ref.environmentId
    ).slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS);
    records.push({
      ...record,
      snapshot: {
        environmentLabel,
        capturedAt: (input.now?.() ?? new Date()).toISOString(),
        transcript: buildThreadContextTranscript(messages),
      },
    });
  }
  return { ok: true, records };
}
