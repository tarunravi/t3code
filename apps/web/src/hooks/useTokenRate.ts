import { useEffect, useRef, useState } from "react";

import { DEFAULT_TOKEN_RATE_WINDOW_MS, TokenRateTracker, formatTokenRate } from "../lib/tokenRate";

const REEVAL_INTERVAL_MS = 1_000;

/**
 * Live client-side rate from cumulative `usedTokens` ticks. `resetKey` drops
 * history when the thread identity changes. `live` is true while the tracker
 * saw a tick inside the current window, so idle threads render the last
 * measured rate dimmed instead of pretending the stream is ongoing.
 */
export function useTokenRate(
  tokenUsage: { readonly usedTokens: number } | null | undefined,
  resetKey: string | null,
  windowMs: number = DEFAULT_TOKEN_RATE_WINDOW_MS,
): { readonly rate: number | null; readonly live: boolean; readonly text: string | null } {
  const trackerRef = useRef<TokenRateTracker | null>(null);
  const trackerKeyRef = useRef<string | null>(resetKey);
  const lastRateRef = useRef<number | null>(null);
  const [state, setState] = useState<{ rate: number | null; live: boolean }>({
    rate: null,
    live: false,
  });

  if (trackerKeyRef.current !== resetKey) {
    trackerKeyRef.current = resetKey;
    trackerRef.current = null;
    lastRateRef.current = null;
    setState({ rate: null, live: false });
  }

  const tracker = trackerRef.current ?? (trackerRef.current = new TokenRateTracker());

  useEffect(() => {
    if (tokenUsage == null) return;
    tracker.push(tokenUsage.usedTokens, Date.now());
    const now = Date.now();
    const rate = tracker.rate(now, windowMs);
    if (rate !== null) lastRateRef.current = rate;
    setState({
      rate: rate ?? lastRateRef.current,
      live: true,
    });
  }, [tokenUsage, tracker, windowMs]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const rate = tracker.rate(now, windowMs);
      if (rate !== null) lastRateRef.current = rate;
      const last = tracker.lastTickAt();
      setState({
        rate: rate ?? lastRateRef.current,
        live: last !== null && now - last <= windowMs,
      });
    }, REEVAL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tracker, windowMs]);

  return { rate: state.rate, live: state.live, text: formatTokenRate(state.rate) };
}
