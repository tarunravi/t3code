import { assert, describe, it } from "@effect/vitest";

import {
  transcribeCodexSpeech,
  type CodexTranscribeDeps,
  type CodexTranscribeFetchResponse,
} from "./codexTranscription.ts";

const credentials = { accessToken: "header.payload.signature", accountId: "acct_1" };
const noSleep = async () => {};
const pcm = new Uint8Array(4_000);

function fetchSequence(
  responses: ReadonlyArray<{
    ok?: boolean;
    status?: number;
    json?: () => Promise<unknown>;
  }>,
) {
  const calls: Array<Parameters<CodexTranscribeDeps["fetchImpl"]>[1]> = [];
  let index = 0;
  const fetchImpl: CodexTranscribeDeps["fetchImpl"] = (url, init) => {
    calls.push(init);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    const response: CodexTranscribeFetchResponse = {
      ok: next.ok ?? false,
      status: next.status ?? 500,
      json: next.json ?? (async () => ({})),
    };
    return Promise.resolve(response);
  };
  return { calls, fetchImpl };
}

const deps = (
  fetchImpl: CodexTranscribeDeps["fetchImpl"],
  readCredentials: () => typeof credentials = () => credentials,
): CodexTranscribeDeps => ({ fetchImpl, readCredentials, sleep: noSleep });

describe("transcribeCodexSpeech", () => {
  it("returns unavailable when no Codex login exists", async () => {
    const { fetchImpl } = fetchSequence([]);
    const result = await transcribeCodexSpeech(
      { pcm },
      deps(fetchImpl, () => {
        throw new Error("No Codex login found on this device.");
      }),
    );
    assert.isFalse(result.ok);
    if (!result.ok) {
      assert.equal(result.code, "unavailable");
      assert.include(result.message, "No Codex login");
    }
  });

  it("posts WAV audio with Codex credentials and returns the transcript", async () => {
    const { calls, fetchImpl } = fetchSequence([
      { ok: true, status: 200, json: async () => ({ text: "hello world" }) },
    ]);
    const result = await transcribeCodexSpeech({ pcm, language: "en" }, deps(fetchImpl));
    assert.deepEqual(result, { ok: true, value: "hello world" });
    assert.lengthOf(calls, 1);
    assert.equal(calls[0]!.headers.Authorization, "Bearer header.payload.signature");
    assert.equal(calls[0]!.headers["ChatGPT-Account-Id"], "acct_1");
  });

  it("retries a 403 bot-mitigation rejection and then succeeds", async () => {
    const { calls, fetchImpl } = fetchSequence([
      { ok: false, status: 403 },
      { ok: true, status: 200, json: async () => ({ text: "recovered" }) },
    ]);
    const result = await transcribeCodexSpeech({ pcm }, deps(fetchImpl));
    assert.deepEqual(result, { ok: true, value: "recovered" });
    assert.lengthOf(calls, 2);
  });

  it("does not retry a 401 auth rejection", async () => {
    const { calls, fetchImpl } = fetchSequence([{ ok: false, status: 401 }]);
    const result = await transcribeCodexSpeech({ pcm }, deps(fetchImpl));
    assert.isFalse(result.ok);
    if (!result.ok) assert.equal(result.code, "unavailable");
    assert.lengthOf(calls, 1);
  });

  it("fails when the transcript is empty", async () => {
    const { fetchImpl } = fetchSequence([
      { ok: true, status: 200, json: async () => ({ text: "  " }) },
    ]);
    const result = await transcribeCodexSpeech({ pcm }, deps(fetchImpl));
    assert.isFalse(result.ok);
    if (!result.ok) assert.equal(result.code, "failed");
  });

  it("gives up with a timeout error when Codex never answers", async () => {
    let attempts = 0;
    const stalled: CodexTranscribeDeps["fetchImpl"] = (_url, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    };
    const result = await transcribeCodexSpeech({ pcm }, { ...deps(stalled), timeoutMs: 20 });
    assert.deepEqual(result, {
      ok: false,
      code: "failed",
      message: "Codex took too long to answer the transcription request. Try again.",
    });
    assert.strictEqual(attempts, 1);
  });

  it("rejects oversized audio without calling the endpoint", async () => {
    const { calls, fetchImpl } = fetchSequence([]);
    const result = await transcribeCodexSpeech(
      { pcm: new Uint8Array(16_000 * 4 * 301) },
      deps(fetchImpl),
    );
    assert.isFalse(result.ok);
    assert.lengthOf(calls, 0);
  });
});
