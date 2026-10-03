import type {
  OrchestratorMcpTarget,
  ServerProvider,
  SubagentRosterEntry,
  ThreadSubagentRoster,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

export const THREAD_ROSTER_GUIDANCE =
  "The user chose these subagents for this thread, in order of preference. Delegate only to these targets; match each task to an entry's role (default = everyday work, hard = the most difficult work, bulk = quick mechanical work, overnight = long unattended runs). Omitting target.model uses the default entry.";

export function describeRosterEntry(entry: SubagentRosterEntry): string {
  const details = [
    ...(entry.role === undefined ? [] : [entry.role]),
    ...(entry.selection.options ?? []).map((option) => `${option.id}=${String(option.value)}`),
  ];
  const target = `${entry.selection.instanceId}/${entry.selection.model}`;
  return details.length === 0 ? target : `${target} (${details.join(", ")})`;
}

function describeRequestedTarget(target: OrchestratorMcpTarget | undefined): string {
  const provider = target?.providerInstanceId ?? target?.driverKind ?? "the inherited provider";
  return target?.model === undefined ? `${provider}` : `${provider}/${target.model}`;
}

/**
 * Maps a delegate_task target onto the thread's roster. Unset fields narrow
 * nothing, so an empty target picks the default entry. The entry's options
 * apply unless the agent supplied its own.
 */
export function resolveRosterTarget(input: {
  readonly roster: ThreadSubagentRoster;
  readonly target: OrchestratorMcpTarget | undefined;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): Result.Result<OrchestratorMcpTarget, string> {
  const { roster, target } = input;
  if (roster.entries.length === 0) {
    return Result.fail("The user allowed no subagents in this thread.");
  }
  const driverByInstance = new Map(
    input.providers.map((provider) => [provider.instanceId, provider.driver]),
  );
  const matches = roster.entries.filter(
    (entry) =>
      (target?.providerInstanceId === undefined ||
        entry.selection.instanceId === target.providerInstanceId) &&
      (target?.driverKind === undefined ||
        driverByInstance.get(entry.selection.instanceId) === target.driverKind) &&
      (target?.model === undefined || entry.selection.model === target.model),
  );
  const entry = matches.find((candidate) => candidate.role === "default") ?? matches[0];
  if (entry === undefined) {
    return Result.fail(
      `${describeRequestedTarget(target)} is not in this thread's subagent roster. Allowed: ${roster.entries
        .map(describeRosterEntry)
        .join("; ")}.`,
    );
  }
  const options = target?.options ?? entry.selection.options;
  return Result.succeed({
    providerInstanceId: entry.selection.instanceId,
    model: entry.selection.model,
    ...(options === undefined ? {} : { options }),
  });
}
