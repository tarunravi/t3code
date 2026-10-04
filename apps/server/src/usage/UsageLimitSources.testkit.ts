/**
 * A UsageLimitSources mock for tests that build OrchestratorMcpService:
 * no sources configured, so capabilities expose only native snapshots.
 *
 * @module usage/UsageLimitSources.testkit
 */
import { UsageLimitSourceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as UsageLimitSources from "./UsageLimitSources.ts";

export const usageSourcesTestLayer = Layer.succeed(UsageLimitSources.UsageLimitSources, {
  current: Effect.succeed([]),
  streamChanges: Stream.empty,
  refresh: Effect.void,
  consumeResetCredit: () =>
    Effect.fail(new UsageLimitSourceError({ detail: "No usage source configured in this test." })),
});
