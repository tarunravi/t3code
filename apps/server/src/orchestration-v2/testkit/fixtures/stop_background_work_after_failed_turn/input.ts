import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

/**
 * The same thread once the idle timeout released its provider session. The
 * release ends the work its process ran, so the thread stops showing it
 * without a Stop.
 */
export function stopBackgroundWorkAfterReleaseInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
    ],
  };
}
