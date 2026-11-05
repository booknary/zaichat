import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatApp } from "../src/ui/ChatApp";
import { MenuLocaleContext } from "../src/ui/menuLocale";
import type { ChatSnapshot } from "../src/core/chatManager";
import type { ModelProfile } from "../src/core/types";

afterEach(() => vi.unstubAllGlobals());
const refs = {
  items: [],
  attachments: [],
  notes: [],
  annotations: [],
  collections: [],
};
function markup(extra: Partial<ChatSnapshot> = {}) {
  vi.stubGlobal("rootURI", "chrome://zaichat/");
  const snapshot: ChatSnapshot = {
    conversations: [],
    running: true,
    runningConversationID: "chat",
    queuePaused: false,
    queuedMessages: [],
    operations: [],
    status: "Agent is running",
    streamingText: "",
    active: {
      schemaVersion: 1,
      id: "chat",
      title: "Synthetic task",
      createdAt: "x",
      updatedAt: "x",
      messages: [],
      lastRun: {
        id: "run",
        conversationID: "chat",
        status: "running",
        startedAt: "x",
        toolCallCount: 2,
        events: [],
      },
    },
    ...extra,
  };
  const manager = {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    availableContext: () => [],
  };
  const profile: ModelProfile = {
    id: "unit",
    displayName: "Test",
    model: "test",
    apiKey: "",
    baseURL: "https://example.test",
    protocol: "auto",
    streaming: true,
    reasoningEnabled: true,
    reasoningEffort: "high",
    timeoutMs: 5000,
    contextBudgetChars: 100000,
    evidenceBudgetChars: 60000,
  };
  return renderToStaticMarkup(
    <MenuLocaleContext.Provider value="en-US">
      <ChatApp
        manager={manager as any}
        window={{} as any}
        getProfile={() => profile}
        getSettings={() => ({
          systemPrompt: "Test",
          maxToolCalls: 80,
          maxAttachments: 20,
        })}
        onExport={() => undefined}
        onLocate={() => undefined}
        onOpen={() => undefined}
        onOpenSettings={() => undefined}
      />
    </MenuLocaleContext.Provider>,
  );
}

it("keeps the composer editable and exposes steering, queue and stop during execution", () => {
  const html = markup();
  expect(html).toContain("zaichat-run-progress");
  expect(html).toContain("Steer this task");
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-label="Follow-up behavior"');
  expect(html).not.toContain("<select");
  expect(html).toContain(">Stop<");
  expect(html.match(/<textarea[^>]*>/u)?.[0]).not.toContain("disabled");
  expect(html).toContain("zaichat-compose-surface");
});

it("shows a real clarification card with selectable and free-text replies", () => {
  const html = markup({
    question: { id: "q", question: "Which scope?", choices: ["Initials", "Full name"] },
  });
  expect(html).toContain("Reply needed");
  expect(html).toContain("Which scope?");
  expect(html).toContain(">Initials<");
  expect(html).toContain("Type your reply");
  expect(html).not.toContain("Follow-up behavior");
});

it("shows held queued messages, escaped content and explicit resume controls", () => {
  const html = markup({
    running: false,
    queuePaused: true,
    queuedMessages: [
      {
        id: "q",
        text: "<script>not executable</script>",
        createdAt: "x",
        contextRefs: refs,
        needsReview: true,
      },
    ],
  });
  expect(html).toContain("Queued messages");
  expect(html).toContain("Resume queue");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

it("does not present another conversation's progress as current-task steering", () => {
  const html = markup({ runningConversationID: "another" });
  expect(html).toContain("Another conversation is running");
  expect(html).not.toContain("zaichat-run-progress");
  expect(html).not.toContain("Follow-up behavior");
});

it("shows only one active status near the composer after guidance", () => {
  const html = markup({ status: "Guidance pending" });
  expect(html).toContain("zaichat-run-progress");
  expect(html).not.toContain('class="zaichat-status"');
  expect(html).not.toContain("Guidance pending");
  expect(html).not.toContain("No explicit context attached");
  expect(html).toMatch(/<details class="zaichat-token-usage"[^>]*>/);
  expect(html.match(/<details class="zaichat-token-usage"[^>]*>/)?.[0]).not.toContain(
    "open",
  );
});
it("shows an active clarification once and restores it to history after replying", () => {
  const active: any = {
    schemaVersion: 1,
    id: "chat",
    title: "Question",
    createdAt: "x",
    updatedAt: "x",
    messages: [
      {
        id: "m",
        role: "assistant",
        questionID: "q",
        displayText: "Unique question?",
        createdAt: "x",
      },
    ],
  };
  const waiting = markup({
    active,
    question: { id: "q", question: "Unique question?", choices: [] },
  });
  expect(waiting.match(/Unique question\?/g)).toHaveLength(1);
  expect(waiting).not.toContain("zaichat-run-progress");
  const resumed = markup({ active, question: undefined });
  expect(resumed.match(/Unique question\?/g)).toHaveLength(1);
});
