import type { UsageFilters } from "@t3tools/contracts";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function UsageDetailFilters({
  filters,
  environments,
  models,
  onChange,
}: {
  readonly filters: UsageFilters;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly models: readonly string[];
  readonly onChange: (filters: UsageFilters) => void;
}) {
  const threads = environments.flatMap(({ label, summary }) =>
    (summary?.threads ?? []).map((thread) => ({
      ...thread,
      label: `${label}: ${thread.title || thread.threadId}${thread.isSubagent ? " (subagent)" : ""}`,
    })),
  );
  const instances = [
    ...new Set(threads.map(({ providerInstanceId }) => providerInstanceId)),
  ].sort();
  const update = (key: keyof UsageFilters, value: string | null) => {
    const next = { ...filters };
    delete next[key];
    if (value && value !== "all") Object.assign(next, { [key]: value });
    onChange(next);
  };
  const fields = [
    {
      key: "model" as const,
      label: "Model",
      options: [...new Set([...models, ...(filters.model ? [filters.model] : [])])]
        .sort()
        .map((value) => ({ value, label: value })),
    },
    {
      key: "providerInstanceId" as const,
      label: "Provider instance",
      options: instances.map((value) => ({ value, label: value })),
    },
    {
      key: "threadKind" as const,
      label: "Thread type",
      options: [
        { value: "agent", label: "Top-level threads" },
        { value: "subagent", label: "Subagents / delegated tasks" },
      ],
    },
    {
      key: "threadId" as const,
      label: "Thread",
      options: [
        ...new Map(
          threads.map((thread) => [
            thread.threadId,
            { value: thread.threadId, label: thread.label },
          ]),
        ).values(),
      ],
    },
  ];
  return (
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Usage detail filters">
      {fields.map(({ key, label, options }) => (
        <Select
          key={key}
          value={filters[key] ?? "all"}
          onValueChange={(value) => update(key, value)}
        >
          <SelectTrigger aria-label={label} size="compact" className="max-w-72">
            <SelectValue>
              {options.find(({ value }) => value === filters[key])?.label ??
                `All ${label.toLowerCase()}s`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All {label.toLowerCase()}s</SelectItem>
            {options.map(({ value, label: title }) => (
              <SelectItem key={value} value={value}>
                {title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ))}
      {filters.threadId || filters.threadKind || filters.providerInstanceId ? (
        <p className="w-full text-xs text-muted-foreground">
          Thread filters include T3-attributed usage only; unlinked CLI history is excluded.
        </p>
      ) : null}
    </div>
  );
}
