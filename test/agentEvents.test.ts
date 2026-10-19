import { describe, expect, it } from "vitest";
import { compactAgentEvents } from "../src/ui/agentEvents";
import type { AgentEvent } from "../src/core/types";

describe("agent event display", () => {
  it("collapses repeated failures and hides their redundant started rows", () => {
    const events: AgentEvent[] = [
      event("tool-call", "read_attachment_snippets started", "tool"),
      event("error", "Tool read_attachment_snippets failed: bad item", "error-1"),
      event("tool-call", "read_attachment_snippets started", "tool-2"),
      event("error", "Tool read_attachment_snippets failed: bad item", "error-2"),
    ];
    expect(compactAgentEvents(events).map((entry) => entry.summary)).toEqual([
      "Tool read_attachment_snippets failed: bad item ×2",
    ]);
  });
});

function event(type: AgentEvent["type"], summary: string, id: string): AgentEvent {
  return {
    id,
    type,
    name: "read_attachment_snippets",
    summary,
    createdAt: new Date(0).toISOString(),
  };
}
