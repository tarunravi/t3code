import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  appendTokenRateSample,
  completedTurnTokenRate,
  formatLiveTokenRate,
  formatTokenRate,
  latestTokenRateTurn,
  liveTokenRateSource,
  rollingTokenRate,
  type TokenRateSample,
} from "../lib/tokenRate";

const LIVE_REFRESH_INTERVAL_MS = 1_000;

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "providerTurns" | "turnItems" | "nodes"
>;

export interface TokenRateProjectionSource {
  readonly key: string;
  readonly projection: Projection | null | undefined;
}

/**
 * Live rolling estimate while a run is active; otherwise the latest completed-turn
 * average. Samples are keyed by run so history never leaks into the next run.
 */
export function useTokenRate(projection: Projection | null | undefined): {
  readonly live: boolean;
  readonly rate: number | null;
  readonly text: string | null;
} {
  const sources = useMemo(() => [{ key: "thread", projection }], [projection]);
  return useTokenRateSources(sources);
}

export function useTokenRateSources(sources: readonly TokenRateProjectionSource[]): {
  readonly live: boolean;
  readonly rate: number | null;
  readonly text: string | null;
} {
  const liveSources = useMemo(() => {
    const seen = new Set<string>();
    return sources.flatMap(({ key, projection }) => {
      if (seen.has(key)) return [];
      seen.add(key);
      const source = liveTokenRateSource(projection);
      return source === null
        ? []
        : [{ key: `${key}:${source.key}`, estimatedTokens: source.estimatedTokens }];
    });
  }, [sources]);
  const [history, setHistory] = useState<ReadonlyMap<string, readonly TokenRateSample[]>>(
    () => new Map(),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (liveSources.length === 0) return;
    const atMs = Date.now();
    setNowMs(atMs);
    setHistory((previous) => {
      const next = new Map<string, readonly TokenRateSample[]>();
      for (const source of liveSources) {
        next.set(
          source.key,
          appendTokenRateSample(previous.get(source.key) ?? [], {
            tokens: source.estimatedTokens,
            atMs,
          }),
        );
      }
      return next;
    });
  }, [liveSources]);

  useEffect(() => {
    if (liveSources.length === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), LIVE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [liveSources]);

  if (liveSources.length > 0) {
    const rates = liveSources.map((source) =>
      rollingTokenRate(history.get(source.key) ?? [], nowMs),
    );
    const availableRates = rates.filter((rate): rate is number => rate !== null);
    const rate =
      availableRates.length === 0 ? null : availableRates.reduce((sum, value) => sum + value, 0);
    return { live: true, rate, text: formatLiveTokenRate(rate) };
  }
  const rootProjection = sources[0]?.projection;
  const rate = completedTurnTokenRate(latestTokenRateTurn(rootProjection));
  return { live: false, rate, text: formatTokenRate(rate) };
}
