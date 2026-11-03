import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
it.effect(
  "Full-access launch inheritance never elevates a caller or silently downgrades a provider",
  () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveRuntimeMode("full-access", "inherit"), "full-access");
      assert.equal(
        (yield* resolveRuntimeMode("auto", "inherit").pipe(Effect.flip)).code,
        "runtime_mode_escalation_denied",
      );
      assert.equal(
        (yield* resolveRuntimeMode("full-access", "auto").pipe(Effect.flip)).code,
        "invalid_request",
      );
      assert.equal(
        (yield* resolveRuntimeMode("full-access", "inherit", {
          modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: "test" },
          supportedRuntimeModes: ["auto"],
        }).pipe(Effect.flip)).code,
        "invalid_request",
      );
    }),
);
