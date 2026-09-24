import type { EnvironmentId, UsageSpeedRow, UsageSpeedSourceStatus } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useUsageSpeed } from "../../state/usage";
import { Skeleton } from "../ui/skeleton";

const HARNESS_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code" };
const SOURCE_LABELS: Record<UsageSpeedSourceStatus["source"], string> = {
  opencodex: "OpenCodex",
  "claude-transcripts": "Claude Code transcripts",
};

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate.toFixed(rate < 10 ? 1 : 0)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

interface SpeedRowWithEnvironment extends UsageSpeedRow {
  readonly environmentLabel: string;
}

/** Token-weighted rate across rows; the headline figure for a harness. */
function weightedRate(rows: readonly UsageSpeedRow[], pick: "output" | "decode"): number | null {
  let tokens = 0;
  let seconds = 0;
  for (const row of rows) {
    const rate = pick === "output" ? row.outputTokensPerSecond : row.decodeTokensPerSecond;
    if (rate === null || rate <= 0) continue;
    tokens += row.outputTokens;
    seconds += row.outputTokens / rate;
  }
  return seconds > 0 ? Math.round((tokens / seconds) * 10) / 10 : null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold text-foreground tabular-nums">{value}</span>
      {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function HarnessSummary({ harness, rows }: { harness: string; rows: readonly UsageSpeedRow[] }) {
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const failed = rows.reduce((sum, row) => sum + row.failedRequests, 0);
  const timed = rows.filter((row) => row.timeToFirstToken !== null);
  // Request-weighted median of medians keeps one busy model from hiding the rest.
  const ttft =
    timed.length === 0
      ? null
      : Math.round(
          timed.reduce((sum, row) => sum + row.timeToFirstToken!.medianMs * row.requests, 0) /
            timed.reduce((sum, row) => sum + row.requests, 0),
        );
  const fastest = rows
    .filter((row) => row.outputTokensPerSecond !== null && row.requests >= 3)
    .toSorted((a, b) => b.outputTokensPerSecond! - a.outputTokensPerSecond!)[0];
  return (
    <div className="grid grid-cols-2 gap-4 rounded-xl border border-border/60 p-4 sm:grid-cols-5">
      <Stat
        label={`${HARNESS_LABELS[harness] ?? harness} requests`}
        value={formatCount(requests)}
      />
      <Stat
        label="Time to first token"
        value={ttft === null ? "—" : formatMs(ttft)}
        hint={ttft === null ? "Not recorded by this source" : "Typical, across models"}
      />
      <Stat
        label="Output tok/s"
        value={formatRate(weightedRate(rows, "output"))}
        hint="End to end"
      />
      <Stat
        label="Decode tok/s"
        value={formatRate(weightedRate(rows, "decode"))}
        hint="After the first token"
      />
      <Stat
        label="Failed"
        value={requests === 0 ? "—" : `${((failed / requests) * 100).toFixed(1)}%`}
        hint={fastest ? `Fastest: ${fastest.model}` : undefined}
      />
    </div>
  );
}

function SpeedTable({
  rows,
  showEnvironment,
}: {
  rows: readonly SpeedRowWithEnvironment[];
  showEnvironment: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 font-normal">Model</th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">Requests</th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">TTFT p50 / p90</th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">Output tok/s</th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">Decode tok/s</th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">
              Duration p50 / p90
            </th>
            <th className="whitespace-nowrap py-2 ps-3 text-right font-normal">Output</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.environmentLabel}:${row.source}:${row.upstream}:${row.model}:${row.effort}:${row.speedTier}`}
              className="border-b border-border/50 transition-colors hover:bg-muted/50"
            >
              <td className="py-2 text-foreground">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{row.model}</span>
                  {row.effort ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {row.effort}
                    </span>
                  ) : null}
                  {row.speedTier && row.speedTier !== "standard" ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                      {row.speedTier}
                    </span>
                  ) : null}
                  {row.upstream && row.upstream !== "openai" ? (
                    <span className="text-[11px] text-muted-foreground">via {row.upstream}</span>
                  ) : null}
                  {showEnvironment ? (
                    <span className="text-[11px] text-muted-foreground">
                      · {row.environmentLabel}
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-foreground tabular-nums">
                {formatCount(row.requests)}
                {row.failedRequests > 0 ? (
                  <span className="text-destructive"> · {row.failedRequests} failed</span>
                ) : null}
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-muted-foreground tabular-nums">
                {row.timeToFirstToken === null
                  ? "—"
                  : `${formatMs(row.timeToFirstToken.medianMs)} / ${formatMs(row.timeToFirstToken.p90Ms)}`}
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-foreground tabular-nums">
                {formatRate(row.outputTokensPerSecond)}
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-muted-foreground tabular-nums">
                {formatRate(row.decodeTokensPerSecond)}
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-muted-foreground tabular-nums">
                {`${formatMs(row.duration.medianMs)} / ${formatMs(row.duration.p90Ms)}`}
              </td>
              <td className="whitespace-nowrap py-2 ps-3 text-right text-muted-foreground tabular-nums">
                {formatCount(row.outputTokens)}
                {row.reasoningTokens > 0 && row.outputTokens > 0 ? (
                  <span>
                    {" "}
                    · {Math.round((row.reasoningTokens / row.outputTokens) * 100)}% reasoning
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Request speed per model: time to first token, tokens per second, and
 * duration. Codex requests are measured by OpenCodex; Claude Code figures are
 * estimated from transcript timestamps.
 */
export function UsageSpeedSection({
  windowDays,
  selectedEnvironmentIds,
}: {
  windowDays: number;
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  // Anchor the window when the range changes, not on every render.
  const [anchor] = useState(() => Date.now());
  const input = useMemo(
    () => ({
      sinceTime: new Date(anchor - windowDays * 86_400_000).toISOString(),
      untilTime: new Date(anchor).toISOString(),
    }),
    [anchor, windowDays],
  );
  const environments = useUsageSpeed(input, selectedEnvironmentIds);
  const isPending = environments.some((environment) => environment.isPending);
  const rows = environments.flatMap((environment) =>
    (environment.summary?.rows ?? []).map((row) => ({
      ...row,
      environmentLabel: environment.label,
    })),
  );
  const showEnvironment = new Set(rows.map((row) => row.environmentLabel)).size > 1;
  const harnesses = [...new Set(rows.map((row) => row.harness))];
  const sourceNotes = environments.flatMap((environment) =>
    (environment.summary?.sources ?? []).flatMap((source) =>
      source.detail === null
        ? []
        : [
            `${showEnvironment ? `${environment.label}: ` : ""}${SOURCE_LABELS[source.source]} — ${source.detail}`,
          ],
    ),
  );

  if (isPending && rows.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {harnesses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No timed requests in this window.</p>
      ) : (
        harnesses.map((harness) => {
          const allRows = rows.filter((row) => row.harness === harness);
          // Routes that never produced output are errors, not speeds.
          const harnessRows = allRows.filter((row) => row.failedRequests < row.requests);
          const failedOnly = allRows.filter((row) => row.failedRequests === row.requests);
          return (
            <section key={harness} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                {HARNESS_LABELS[harness] ?? harness}
                <span className="ms-2 text-xs font-normal text-muted-foreground">
                  {harnessRows[0]!.source === "opencodex"
                    ? "Measured by OpenCodex"
                    : "Estimated from transcripts"}
                </span>
              </h2>
              <HarnessSummary harness={harness} rows={allRows} />
              <SpeedTable rows={harnessRows} showEnvironment={showEnvironment} />
              {failedOnly.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {`${failedOnly.reduce((sum, row) => sum + row.requests, 0)} requests failed without output: `}
                  {failedOnly
                    .map(
                      (row) =>
                        `${row.model}${row.effort ? ` ${row.effort}` : ""} (${row.requests})`,
                    )
                    .join(", ")}
                </p>
              ) : null}
            </section>
          );
        })
      )}
      {environments.some((environment) => environment.error !== null) ? (
        <p className="text-xs text-destructive">
          {environments
            .filter((environment) => environment.error !== null)
            .map((environment) => `${environment.label}: ${environment.error}`)
            .join(" ")}
        </p>
      ) : null}
      {sourceNotes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {sourceNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
