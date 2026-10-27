import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import {
  appendTokenRateSample,
  chooseLiveTokenRate,
  completedTurnTokenRate,
  formatLiveTokenRate,
  formatTokenRate,
  latestTokenRateTurn,
  liveTokenRateSource,
  LIVE_TOKEN_RATE_WINDOW_MS,
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
  return useTokenRateSources([{ key: "thread", projection }]);
}

export function useTokenRateSources(sources: readonly TokenRateProjectionSource[]): {
  readonly live: boolean;
  readonly rate: number | null;
  readonly text: string | null;
} {
  const seen = new Set<string>();
  const liveSources = sources.flatMap(({ key, projection }) => {
    if (seen.has(key)) return [];
    seen.add(key);
    const source = liveTokenRateSource(projection);
    return source === null
      ? []
      : [
          {
            key: `${key}:${source.key}`,
            estimatedTokens: source.estimatedTokens,
            measured: source.measured === true,
            fallbackEstimatedTokens: source.fallbackEstimatedTokens,
          },
        ];
  });
  const sampleSources = liveSources.flatMap((source) => [
    source,
    ...(source.fallbackEstimatedTokens === undefined
      ? []
      : [{ key: `${source.key}:text`, estimatedTokens: source.fallbackEstimatedTokens }]),
  ]);
  const [{ history, nowMs }, setSampling] = useState(() => ({
    history: new Map<string, readonly TokenRateSample[]>(),
    nowMs: Date.now(),
  }));
  const live = liveSources.length > 0;

  // oxlint-disable-next-line t3code/react-effect-budget -- Timestamp external provider counter changes after commit, not during render.
  useEffect(() => {
    if (sampleSources.length === 0) return;
    const atMs = Date.now();
    // oxlint-disable-next-line react/set-state-in-effect -- Each token update is a timestamped sample, and render must not read the clock.
    setSampling((previous) => {
      // Equivalent projections and timer renders must not create another sampling update.
      if (
        previous.history.size === sampleSources.length &&
        sampleSources.every(
          (source) => previous.history.get(source.key)?.at(-1)?.tokens === source.estimatedTokens,
        )
      )
        return previous;
      const next = new Map<string, readonly TokenRateSample[]>();
      for (const source of sampleSources) {
        next.set(
          source.key,
          appendTokenRateSample(previous.history.get(source.key) ?? [], {
            tokens: source.estimatedTokens,
            atMs,
          }),
        );
      }
      return { history: next, nowMs: atMs };
    });
  }, [sampleSources]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Age live samples against wall-clock time and release the timer when idle.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(
      () => setSampling((previous) => ({ ...previous, nowMs: Date.now() })),
      LIVE_REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [live]);

  if (liveSources.length > 0) {
    const rates = liveSources.map((source) =>
      chooseLiveTokenRate(
        source.measured ? history.get(source.key) : undefined,
        history.get(source.measured ? `${source.key}:text` : source.key) ?? [],
        nowMs,
      ),
    );
    const availableRates = rates
      .map(({ rate }) => rate)
      .filter((rate): rate is number => rate !== null);
    const rate =
      availableRates.length === 0 ? null : availableRates.reduce((sum, value) => sum + value, 0);
    const noRecentOutput = sampleSources.every((source) => {
      const newest = history.get(source.key)?.at(-1);
      return newest !== undefined && nowMs - newest.atMs >= LIVE_TOKEN_RATE_WINDOW_MS;
    });
    return {
      live: true,
      rate,
      text:
        formatLiveTokenRate(
          rate,
          rates.some((sample) => sample.rate !== null && !sample.measured),
        ) ?? (noRecentOutput ? "No recent visible output" : "Measuring…"),
    };
  }
  const rootProjection = sources[0]?.projection;
  const rate = completedTurnTokenRate(latestTokenRateTurn(rootProjection));
  return { live: false, rate, text: formatTokenRate(rate) };
}
