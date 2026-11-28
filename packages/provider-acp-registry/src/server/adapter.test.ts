import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as EffectAcpErrors from "effect-acp/errors";

import { acpRegistryPromptFailure } from "./adapter.ts";

const requestError = (errorMessage: string, code = -32603) =>
  new EffectAcpErrors.AcpRequestError({ code, errorMessage });

describe("acpRegistryPromptFailure", () => {
  it("classifies a rate-limit answer as a usage limit and reads its reset", () => {
    const at = (iso: string) => DateTime.makeUnsafe(iso);
    const cases = [
      {
        // Resuming 23 seconds later would hit the limit again; the resume waits at least 30.
        name: "Devin request limit, relative reset sooner than the minimum resume delay",
        message:
          "Reached request rate limit. Please switch to a different model or contact support. Your limit will reset in 23 seconds (at 22:57 UTC).",
        now: at("2026-11-22T22:56:40Z"),
        resetAt: "2026-11-22T22:57:10.000Z",
      },
      {
        name: "relative reset with a thousands separator",
        message: "Reached request rate limit. Your limit will reset in 1,000 seconds.",
        now: at("2026-11-22T22:00:00Z"),
        resetAt: "2026-11-22T22:16:40.000Z",
      },
      {
        // The minute-precision clock already passed; the seconds count still wins.
        name: "Devin free-model limit, stale clock time",
        message:
          "Reached free model rate limit. Please switch to a different model. Your limit will reset in 58 seconds (at 09:01 UTC).",
        now: at("2026-11-22T09:01:30Z"),
        resetAt: "2026-11-22T09:02:28.000Z",
      },
      {
        name: "compound relative reset",
        message: "Usage limit reached. Try again in 1 hour 30 minutes.",
        now: at("2026-11-22T10:00:00Z"),
        resetAt: "2026-11-22T11:30:00.000Z",
      },
      {
        name: "clock time later today",
        message: "Rate limit reached. Your limit will reset at 23:15 UTC.",
        now: at("2026-11-22T22:00:00Z"),
        resetAt: "2026-11-22T23:15:00.000Z",
      },
      {
        name: "clock time already passed today rolls to tomorrow",
        message: "Rate limit reached. Your limit will reset at 09:01 UTC.",
        now: at("2026-11-22T21:00:00Z"),
        resetAt: "2026-11-23T09:01:00.000Z",
      },
      {
        name: "ISO timestamp",
        message: "Quota exhausted; resets at 2026-11-23T00:00:00Z.",
        now: at("2026-11-22T21:00:00Z"),
        resetAt: "2026-11-23T00:00:00.000Z",
      },
    ];
    for (const { name, message, now, resetAt } of cases) {
      assert.deepEqual(
        acpRegistryPromptFailure("devin", requestError(message), now),
        { class: "usage_limit", message, code: "-32603", retryable: true, resetAt },
        name,
      );
    }
  });

  it("classifies a rate limit without a reset as a usage limit that cannot arm", () => {
    const message = "Rate limit exceeded. Please contact support.";
    assert.deepEqual(
      acpRegistryPromptFailure(
        "kimi-code",
        requestError(message),
        DateTime.makeUnsafe("2026-11-22T21:00:00Z"),
      ),
      { class: "usage_limit", message, code: "-32603", retryable: true },
    );
  });

  it("leaves other errors as provider errors and keeps Mistral Vibe's code path", () => {
    const now = DateTime.makeUnsafe("2026-11-22T21:00:00Z");
    assert.deepEqual(
      acpRegistryPromptFailure(
        "devin",
        requestError("Model generate limit: context too long."),
        now,
      ),
      {
        class: "provider_error",
        message: "Model generate limit: context too long.",
        code: "-32603",
        retryable: null,
      },
    );
    const vibeMessage = "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).";
    assert.deepEqual(
      acpRegistryPromptFailure("mistral-vibe", requestError(vibeMessage, -31001), now),
      { class: "usage_limit", message: vibeMessage, code: "-31001", retryable: null },
    );
  });
});
