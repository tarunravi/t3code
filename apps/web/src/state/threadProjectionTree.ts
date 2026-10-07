import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { environmentThreadDetails } from "./threads";

export interface ThreadProjectionTreeEntry {
  readonly ref: ScopedThreadRef;
  readonly depth: number;
  readonly title: string | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
}

const EMPTY_TREE_ATOM = Atom.make<readonly ThreadProjectionTreeEntry[]>([]).pipe(
  Atom.withLabel("web-thread-projection-tree:empty"),
);

/** Walks delegated threads breadth-first and ignores malformed lineage cycles. */
export const threadProjectionTreeAtom = Atom.family((key: string) =>
  Atom.make((get): readonly ThreadProjectionTreeEntry[] => {
    const root = parseThreadKey(key);
    const queue: ThreadProjectionTreeEntry[] = [
      { ref: root, depth: 0, title: null, projection: null },
    ];
    const visited = new Set<string>([key]);
    const entries: ThreadProjectionTreeEntry[] = [];
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const thread = get(environmentThreadDetails.threadAtom(entry.ref));
      const projection = thread?.projection ?? null;
      const current = { ...entry, projection };
      entries.push(current);
      for (const subagent of projection?.subagents ?? []) {
        if (subagent.childThreadId === null) continue;
        const childRef = scopeThreadRef(entry.ref.environmentId, subagent.childThreadId);
        const childKey = threadKey(childRef);
        if (visited.has(childKey)) continue;
        visited.add(childKey);
        queue.push({
          ref: childRef,
          depth: entry.depth + 1,
          title: subagent.title,
          projection: null,
        });
      }
    }
    return entries;
  }).pipe(Atom.withLabel(`web-thread-projection-tree:${key}`)),
);

export function useThreadProjectionTree(
  ref: ScopedThreadRef | null,
): readonly ThreadProjectionTreeEntry[] {
  return useAtomValue(ref === null ? EMPTY_TREE_ATOM : threadProjectionTreeAtom(threadKey(ref)));
}
