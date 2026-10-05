import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef, UsageModelRate } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  estimateThreadCost,
  threadCostModels,
  type ThreadCostEstimate,
  type ThreadCostSource,
} from "../lib/threadCost";
import { serverEnvironment } from "./server";
import { environmentThreadDetails } from "./threads";

const EMPTY_ESTIMATE_ATOM = Atom.make<ThreadCostEstimate | null>(null).pipe(
  Atom.withLabel("web-thread-cost:empty"),
);

/**
 * Walks delegated child threads breadth-first. The visited set keeps a
 * malformed parent/child cycle from recursing forever.
 */
const threadCostSourcesAtom = Atom.family((key: string) =>
  Atom.make((get): readonly ThreadCostSource[] => {
    const root = parseThreadKey(key);
    const queue: { ref: ScopedThreadRef; depth: number; title: string | null }[] = [
      { ref: root, depth: 0, title: null },
    ];
    const visited = new Set<string>([key]);
    const sources: ThreadCostSource[] = [];
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const thread = get(environmentThreadDetails.threadAtom(entry.ref));
      const projection = thread?.projection ?? null;
      sources.push({
        threadId: entry.ref.threadId,
        title: entry.title ?? projection?.thread.title ?? "Subagent",
        depth: entry.depth,
        projection,
      });
      for (const subagent of projection?.subagents ?? []) {
        if (subagent.childThreadId === null) continue;
        const childRef = scopeThreadRef(entry.ref.environmentId, subagent.childThreadId);
        const childKey = threadKey(childRef);
        if (visited.has(childKey)) continue;
        visited.add(childKey);
        queue.push({ ref: childRef, depth: entry.depth + 1, title: subagent.title });
      }
    }
    return sources;
  }).pipe(Atom.withLabel(`web-thread-cost:sources:${key}`)),
);

const threadCostAtom = Atom.family((key: string) =>
  Atom.make((get): ThreadCostEstimate | null => {
    const sources = get(threadCostSourcesAtom(key));
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
