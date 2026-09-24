import { describe, expect, it, vi } from "vite-plus/test";

import {
  transcribeWithRetry,
  VOICE_TRANSCRIBE_MAX_ATTEMPTS,
  type TranscribeFetchResponse,
  type TranscribeWithRetryDeps,
} from "./transcribeWithRetry.ts";

function jsonResponse(status: number, payload: unknown): TranscribeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

function depsWith(
  fetchImpl: TranscribeWithRetryDeps["fetchImpl"],
  overrides?: Partial<TranscribeWithRetryDeps>,
): TranscribeWithRetryDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    fetchImpl,
    readCredentials: () => ({ accessToken: "token", accountId: null }),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
    sleeps,
  };
}

const INPUT = {
  audioBase64: Buffer.from("audio-bytes").toString("base64"),
  mimeType: "audio/webm",
};

describe("transcribeWithRetry", () => {
  it("returns the transcript on the first attempt", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "hello" })));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome).toEqual({ ok: true, text: "hello", attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toEqual([]);
  });

  it.each([403, 429, 500, 503])("retries a %i then succeeds", async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(status, {}))
      .mockResolvedValueOnce(jsonResponse(200, { text: "recovered" }));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome).toEqual({ ok: true, text: "recovered", attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(deps.sleeps).toEqual([500]);
  });

  it("retries network errors then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { text: "recovered" }));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome).toEqual({ ok: true, text: "recovered", attempts: 2 });
  });

  it("gives up after max attempts", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(503, {})));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(VOICE_TRANSCRIBE_MAX_ATTEMPTS);
    expect(fetchImpl).toHaveBeenCalledTimes(VOICE_TRANSCRIBE_MAX_ATTEMPTS);
    expect(deps.sleeps).toEqual([500, 1000]);
  });

  it("fails fast on 401 without retrying", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(401, {})));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deps.sleeps).toEqual([]);
  });

  it("fails fast on non-retryable statuses without retrying", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(400, {})));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails fast on missing login without attempting", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "x" })));
    const deps = depsWith(fetchImpl, {
      readCredentials: () => {
        throw new Error("No Codex login found.");
      },
    });

    const outcome = await transcribeWithRetry(INPUT, deps);

    expect(outcome).toEqual({
      ok: false,
      error: new Error("No Codex login found."),
      attempts: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails fast on empty recordings without attempting", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "x" })));
    const deps = depsWith(fetchImpl);

    const outcome = await transcribeWithRetry({ audioBase64: "", mimeType: "audio/webm" }, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
