import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadSnapshotMessage } from "../lib/threadContextSnapshot";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "./orchestration";
import { environmentServerConfigsAtom } from "./server";

// A disconnected environment would otherwise leave the query waiting for a connection.
const THREAD_SNAPSHOT_FETCH_TIMEOUT_MS = 15_000;

/** Recent messages of a thread via the server-bounded projection, or null when unreachable. */
export async function fetchThreadSnapshotMessages(
  ref: ScopedThreadRef,
): Promise<ReadonlyArray<ThreadSnapshotMessage> | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    orchestrationEnvironment.v2.threadProjection({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    }),
    {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
      signal: AbortSignal.timeout(THREAD_SNAPSHOT_FETCH_TIMEOUT_MS),
    },
  );
  return result._tag === "Success" ? result.value.messages : null;
}

export function readEnvironmentLabel(environmentId: EnvironmentId): string | null {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.label ?? null
  );
}
