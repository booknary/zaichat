import { describe, expect, it } from "vitest";
import { markdownPath } from "../src/hooks";
import { conversationMarkdown } from "../src/core/chatManager";

describe("Markdown export", () => {
  it("preserves or appends the Markdown extension", () => {
    expect(markdownPath("C:\\Exports\\chat.md")).toBe("C:\\Exports\\chat.md");
    expect(markdownPath("C:\\Exports\\chat")).toBe("C:\\Exports\\chat.md");
  });

  it("excludes provider reasoning and protocol-only history by default", () => {
    const markdown = conversationMarkdown({
      schemaVersion: 1,
      id: "chat-1",
      title: "Diagnostics privacy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          displayText: "Visible answer",
          createdAt: new Date().toISOString(),
          agentEvents: [
            {
              id: "reasoning-1",
              type: "provider-reasoning",
              summary: "Model reasoning returned",
              reasoningContent: "raw private reasoning",
              createdAt: new Date().toISOString(),
            },
          ],
          protocolHistory: [
            {
              role: "assistant",
              content: "",
              reasoningContent: "protocol private reasoning",
              toolCalls: [],
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("Visible answer");
    expect(markdown).not.toContain("raw private reasoning");
    expect(markdown).not.toContain("protocol private reasoning");
  });
});
