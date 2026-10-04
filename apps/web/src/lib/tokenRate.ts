import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/**
 * Rolling-window tokens-per-second from client-observed usage ticks. The
 * provider reports cumulative `usedTokens` per turn; the rate is the token
 * delta across the ticks that landed inside the window, over the elapsed
 * span between the oldest and newest of them.
 */
export const DEFAULT_TOKEN_RATE_WINDOW_MS = 8_000;

export interface TokenRateSample {
  readonly usedTokens: number;
  readonly nowMs: number;
}

/** One sample per tick; a turn reset (usedTokens drops) clears history. */
export class TokenRateTracker {
  private samples: TokenRateSample[] = [];

  push(usedTokens: number, nowMs: number): void {
    if (!Number.isFinite(usedTokens) || !Number.isFinite(nowMs)) return;
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && usedTokens < last.usedTokens) this.samples = [];
    this.samples.push({ usedTokens: Math.max(0, usedTokens), nowMs });
    if (this.samples.length > 512) this.samples = this.samples.slice(-512);
  }

  /** Tokens per second, or null when no measurable span exists yet. */
  rate(nowMs: number, windowMs: number = DEFAULT_TOKEN_RATE_WINDOW_MS): number | null {
    return tokenRateFromSamples(this.samples, nowMs, windowMs);
  }

  /** Wall-clock of the newest tick, for live/idle styling. */
  lastTickAt(): number | null {
    return this.samples[this.samples.length - 1]?.nowMs ?? null;
  }
}

export function tokenRateFromSamples(
  samples: readonly TokenRateSample[],
  nowMs: number,
  windowMs: number = DEFAULT_TOKEN_RATE_WINDOW_MS,
): number | null {
  // Base tick: the newest sample at or before the window start, so a sparse
  // tick just outside the window still yields a rate.
  let base: TokenRateSample | null = null;
  let newest: TokenRateSample | null = null;
  for (const sample of samples) {
    if (sample.nowMs <= nowMs - windowMs) {
      base = sample;
    } else if (sample.nowMs <= nowMs) {
      if (newest === null && base === null) {
        // No pre-window base; the first in-window sample is the floor.
        base = sample;
      }
      newest = sample;
    }
  }
  const oldest = base;
  if (newest === null || oldest === null || newest === oldest) return null;
  const elapsedMs = newest.nowMs - oldest.nowMs;
  if (elapsedMs <= 0) return null;
  const delta = newest.usedTokens - oldest.usedTokens;
  if (delta <= 0) return null;
  return (delta / elapsedMs) * 1000;
}

export function formatTokenRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `${Math.max(0, Math.round(rate))} tok/s`;
}

/** Latest provider-reported usage across a projection's turns. */
export function latestTokenUsage(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns"> | null | undefined,
): { readonly usedTokens: number } | null {
  const turns = projection?.providerTurns;
  if (!turns) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const usage = turns[index]?.tokenUsage;
    if (usage !== undefined) return usage;
  }
  return null;
}
