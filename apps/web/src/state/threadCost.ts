import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef, UsageModelRate } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  estimateThreadCost,
  threadCostModels,
  type ThreadCostEstimate,
  type ThreadCostSource,
} from "../lib/threadCost";
import { serverEnvironment } from "./server";
import { threadProjectionTreeAtom } from "./threadProjectionTree";

const EMPTY_ESTIMATE_ATOM = Atom.make<ThreadCostEstimate | null>(null).pipe(
  Atom.withLabel("web-thread-cost:empty"),
);

const threadCostAtom = Atom.family((key: string) =>
  Atom.make((get): ThreadCostEstimate | null => {
    const sources = get(threadProjectionTreeAtom(key)).map(
      (entry) =>
        ({
          threadId: entry.ref.threadId,
          title: entry.title ?? entry.projection?.thread.title ?? "Subagent",
          depth: entry.depth,
          projection: entry.projection,
        }) satisfies ThreadCostSource,
    );
    const models = threadCostModels(sources);
    const rates = new Map<string, UsageModelRate | null>();
    if (models.length > 0) {
      const result = get(
        serverEnvironment.usageModelRates({
          environmentId: parseThreadKey(key).environmentId,
          input: { models },
        }),
      );
      for (const entry of Option.getOrNull(AsyncResult.value(result))?.models ?? [])
        rates.set(entry.model, entry.rate);
    }
    return estimateThreadCost(sources, rates);
  }).pipe(Atom.withLabel(`web-thread-cost:${key}`)),
);

/** Estimated cost of a thread plus its delegated subagents, priced like the Usage page. */
export function useThreadCostEstimate(ref: ScopedThreadRef | null): ThreadCostEstimate | null {
  return useAtomValue(ref === null ? EMPTY_ESTIMATE_ATOM : threadCostAtom(threadKey(ref)));
}
