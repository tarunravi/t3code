import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { useEffect, useState } from "react";
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
  "runs" | "attempts" | "providerTurns" | "turnItems"
>;

/**
 * Live rolling estimate while a run is active; otherwise the latest completed-turn
 * average. Samples are keyed by run so history never leaks into the next run.
 */
export function useTokenRate(projection: Projection | null | undefined): {
  readonly live: boolean;
  readonly rate: number | null;
  readonly text: string | null;
} {
  const source = liveTokenRateSource(projection);
  const sourceKey = source?.key ?? null;
  const estimatedTokens = source?.estimatedTokens ?? null;
  const [history, setHistory] = useState<{
    readonly key: string | null;
    readonly samples: readonly TokenRateSample[];
  }>({ key: null, samples: [] });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (sourceKey === null || estimatedTokens === null) return;
    const atMs = Date.now();
    setNowMs(atMs);
    setHistory((previous) => ({
      key: sourceKey,
      samples: appendTokenRateSample(previous.key === sourceKey ? previous.samples : [], {
        tokens: estimatedTokens,
        atMs,
      }),
    }));
  }, [sourceKey, estimatedTokens]);

  useEffect(() => {
    if (sourceKey === null) return;
    const id = setInterval(() => setNowMs(Date.now()), LIVE_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sourceKey]);

  if (sourceKey !== null) {
    const samples = history.key === sourceKey ? history.samples : [];
    const rate = rollingTokenRate(samples, nowMs);
    return { live: true, rate, text: formatLiveTokenRate(rate) };
  }
  const rate = completedTurnTokenRate(latestTokenRateTurn(projection));
  return { live: false, rate, text: formatTokenRate(rate) };
}
