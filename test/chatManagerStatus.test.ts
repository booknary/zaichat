import { describe, expect, it } from "vitest";
import { finalRunStatus } from "../src/core/chatManager";
import type { AgentRun } from "../src/core/types";

describe("chat completion status", () => {
  it("does not report Ready after a recoverable tool error", () => {
    const run: AgentRun = {
      id: "run-1",
      conversationID: "conversation-1",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      toolCallCount: 1,
      events: [
        {
          id: "event-1",
          type: "error",
          name: "search_fulltext",
          status: "failed",
          summary: "Full-text verification failed",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    expect(finalRunStatus(run)).toBe("Completed with tool errors");
  });
});
