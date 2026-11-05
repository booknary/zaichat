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

it("distinguishes repaired answer validation from actual tool failures", () => {
  const event = (type: string, name: string, summary: string, status = "failed") => ({
    id: summary,
    type,
    name,
    summary,
    status,
    createdAt: "x",
  });
  const validation = event(
    "error",
    "finish_answer",
    "Citation repair needed: use current evidence IDs",
  );
  const accepted = event(
    "tool-result",
    "finish_answer",
    "Answer completed",
    "completed",
  );
  const run = { status: "completed", events: [validation, accepted] } as AgentRun;
  expect(finalRunStatus(run)).toBe("Completed after answer repair");
  run.events.push(event("error", "search_fulltext", "Read failed") as any);
  expect(finalRunStatus(run)).toBe("Completed with tool errors");
  run.events = [validation] as any;
  expect(finalRunStatus(run)).toBe("Completed with tool errors");
  run.events = [
    event("error", "finish_answer", "Unexpected plugin exception"),
    accepted,
  ] as any;
  expect(finalRunStatus(run)).toBe("Completed with tool errors");
});
