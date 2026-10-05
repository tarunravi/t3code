import type { SubagentRosterEntry } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  resolveRosterEntry,
  rosterEntryKey,
  rosterOptionChips,
  SUBAGENT_ROLE_META,
} from "./threadSubagentRoster.logic";

function RosterSummaryEntry(props: {
  entry: SubagentRosterEntry;
  instances: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const resolved = resolveRosterEntry(props.entry, props.instances);
  const role = props.entry.role === undefined ? null : SUBAGENT_ROLE_META[props.entry.role];
  const chips = rosterOptionChips(props.entry.selection, resolved.model);
  return (
    <li className="flex min-w-0 gap-2.5 px-3 py-2.5">
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/72 ring-1 ring-border/60">
        {resolved.instance ? (
          <ProviderInstanceIcon
            driverKind={resolved.instance.driverKind}
            displayName={resolved.instance.displayName}
            accentColor={resolved.instance.accentColor}
            acpRegistryAgentId={resolved.instance.acpRegistryAgentId}
            acpRegistryIconUrl={resolved.instance.acpRegistryIconUrl}
            className="size-4"
            iconClassName="size-4"
            {...(resolved.unavailableReason === null ? {} : { statusDotClassName: "bg-warning" })}
          />
        ) : (
          <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {resolved.modelLabel}
          </span>
          {role === null ? null : (
            <Badge variant={role.badge} size="sm" title={role.description}>
              {role.label}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <span className="me-0.5 truncate text-2xs text-muted-foreground">
            {resolved.instance?.displayName ?? props.entry.selection.instanceId}
          </span>
          {chips.map((chip) => (
            <Badge key={chip.id} variant="outline" size="sm" title={chip.title ?? undefined}>
              {chip.label}
            </Badge>
          ))}
        </div>
        {resolved.unavailableReason === null ? null : (
          <p className="mt-1.5 text-2xs leading-snug text-warning-foreground">
            {resolved.unavailableReason}
          </p>
        )}
        {props.entry.description ? (
          <p className="mt-1.5 text-2xs leading-snug text-muted-foreground text-pretty">
            {props.entry.description}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Read-only roster card: who the thread's agent may delegate to, in preference order. */
export function SubagentRosterSummary(props: {
  entries: ReadonlyArray<SubagentRosterEntry>;
  instances: ReadonlyArray<ProviderInstanceEntry>;
}) {
  return (
    <ul
      className="m-0 flex list-none flex-col divide-y divide-border/65 p-0"
      aria-label="Current subagent roster"
    >
      {props.entries.map((entry) => (
        <RosterSummaryEntry key={rosterEntryKey(entry)} entry={entry} instances={props.instances} />
      ))}
    </ul>
  );
}
