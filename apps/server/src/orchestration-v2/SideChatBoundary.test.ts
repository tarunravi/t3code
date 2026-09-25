import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { withSideChatBoundary } from "./SideChatBoundary.ts";

const parentThreadId = ThreadId.make("thread:side-parent");
const lineage = (relationshipToParent: "side" | "fork" | null) => ({
  lineage: {
    parentThreadId: relationshipToParent === null ? null : parentThreadId,
    relationshipToParent,
    rootThreadId: parentThreadId,
  },
});

describe("withSideChatBoundary", () => {
  it("puts the boundary before a side chat's first native message", () => {
    const text = withSideChatBoundary({
      thread: lineage("side"),
      startsNativeThread: true,
      text: "What are you doing right now?",
    });

    expect(text.startsWith("<side_conversation_boundary>")).toBe(true);
    expect(text.endsWith("</side_conversation_boundary>\n\nWhat are you doing right now?")).toBe(
      true,
    );
    expect(text).toContain("It is not your current task.");
    expect(text).toContain("Sub-agents are off-limits");
    expect(text).toContain("Do not modify files");
    expect(text).toContain(`t3_thread_send using threadId "${parentThreadId}"`);
  });

  it("leaves later side messages and other threads unchanged", () => {
    const text = "Follow-up";
    expect(withSideChatBoundary({ thread: lineage("side"), startsNativeThread: false, text })).toBe(
      text,
    );
    expect(withSideChatBoundary({ thread: lineage("fork"), startsNativeThread: true, text })).toBe(
      text,
    );
    expect(withSideChatBoundary({ thread: lineage(null), startsNativeThread: true, text })).toBe(
      text,
    );
  });
});
