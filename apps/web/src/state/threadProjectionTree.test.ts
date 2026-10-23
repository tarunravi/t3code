import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { threadKey } from "@t3tools/client-runtime/state/entities";

vi.mock("./threads", () => ({ environmentThreadDetails: { threadAtom: () => Atom.make(null) } }));
import { createThreadProjectionTreeAtom } from "./threadProjectionTree";

const ref = (id: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(id),
});
const projection = (children: readonly string[]) =>
  ({
    subagents: children.map((id) => ({ childThreadId: ThreadId.make(id), title: id })),
  }) as unknown as OrchestrationV2ThreadProjection;

describe("thread projection cost ancestry", () => {
  it("loads only linked descendants, deduplicating nested links and cycles", () => {
    const projections = new Map([
      ["parent", projection(["child", "child"])],
      ["child", projection(["grandchild"])],
      ["grandchild", projection(["parent"])],
      ["unrelated", projection([])],
      ["fork", projection([])],
    ]);
    const requested: string[] = [];
    const tree = createThreadProjectionTreeAtom((value) => {
      requested.push(value.threadId);
      const valueProjection = projections.get(value.threadId);
      return Atom.make(valueProjection ? { projection: valueProjection } : null);
    });
    const registry = AtomRegistry.make();
    try {
      expect(
        registry
          .get(tree(threadKey(ref("parent"))))
          .map((entry) => [entry.ref.threadId, entry.depth]),
      ).toEqual([
        ["parent", 0],
        ["child", 1],
        ["grandchild", 2],
      ]);
      expect(requested).toEqual(["parent", "child", "grandchild"]);
    } finally {
      registry.dispose();
    }
  });

  it("retains unloaded child placeholders and reacts when their projections arrive", () => {
    const parent = Atom.make({ projection: projection(["child"]) });
    const child = Atom.make<{ projection: OrchestrationV2ThreadProjection } | null>(null);
    const tree = createThreadProjectionTreeAtom((value) =>
      value.threadId === "parent" ? parent : child,
    );
    const registry = AtomRegistry.make();
    const treeAtom = tree(threadKey(ref("parent")));
    const unmount = registry.mount(treeAtom);
    try {
      expect(registry.get(treeAtom)[1]?.projection).toBeNull();
      registry.set(child, { projection: projection([]) });
      expect(registry.get(treeAtom)[1]?.projection).not.toBeNull();
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
