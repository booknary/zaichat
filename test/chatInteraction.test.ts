import { expect, it, vi } from "vitest";
import { ChatManager } from "../src/core/chatManager";
import {
  ConversationRepository,
  ConversationFileStore,
} from "../src/core/conversationRepository";
import { ContextManager } from "../src/core/contextManager";
import type { AgentRun, ModelProfile } from "../src/core/types";

class MemoryStore implements ConversationFileStore {
  files = new Map<string, string>();
  async read(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async move(from: string, to: string) {
    const value = await this.read(from);
    this.files.set(to, value);
    this.files.delete(from);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdir() {}
  join(...parts: string[]) {
    return parts.join("/");
  }
}
const profile: ModelProfile = {
  id: "unit",
  displayName: "Unit",
  model: "unit-model",
  baseURL: "https://example.test/v1",
  apiKey: "synthetic-private-value",
  protocol: "native-tools",
  streaming: true,
  reasoningEnabled: true,
  reasoningEffort: "high",
  timeoutMs: 5000,
  contextBudgetChars: 100000,
  evidenceBudgetChars: 60000,
};
const limits = { maxToolCalls: 80, maxAttachments: 20 };

async function fixture(store = new MemoryStore()) {
  const repository = new ConversationRepository(store, "root");
  const calls: any[] = [],
    steers: any[] = [];
  const runner = {
    run: vi.fn(
      (
        conversationID,
        messages,
        context,
        selectedProfile,
        _prompt,
        _limits,
        callbacks,
      ) => {
        const run: AgentRun = {
          id: `run-${calls.length}`,
          conversationID,
          startedAt: new Date().toISOString(),
          status: "running",
          toolCallCount: 0,
          events: [],
        };
        callbacks.onRun(run);
        return new Promise((resolve) =>
          calls.push({ run, messages, context, callbacks, selectedProfile, resolve }),
        );
      },
    ),
    steer: vi.fn((input) => {
      steers.push(input);
    }),
    cancel: vi.fn(() => {
      const call = calls.at(-1);
      call?.resolve({
        run: { ...call.run, status: "cancelled" },
        answer: "Cancelled",
        sources: [],
      });
    }),
  };
  const manager = new ChatManager(
    repository,
    new ContextManager({} as any),
    runner as any,
    { reject: vi.fn() } as any,
    { flush: async () => undefined } as any,
  );
  await manager.initialize();
  const send = (text: string) => manager.send(text, [], profile, "System", limits);
  const submit = (text: string, mode: "steer" | "queue" = "steer") =>
    manager.submit(text, [], profile, "System", limits, mode);
  const finish = (index: number, status = "completed") => {
    const call = calls[index];
    call.resolve({ run: { ...call.run, status }, answer: "Completed", sources: [] });
  };
  return { manager, repository, store, calls, steers, runner, send, submit, finish };
}

it("persists multiple guidance messages once and synchronizes subscribers", async () => {
  const f = await fixture(),
    left = vi.fn(),
    right = vi.fn();
  f.manager.subscribe(left);
  f.manager.subscribe(right);
  const running = f.send("Find a paper");
  await f.submit("It may use an abbreviation");
  await f.submit("Only the first author");
  expect(f.calls).toHaveLength(1);
  expect(
    f.manager
      .getSnapshot()
      .active?.messages.filter((entry) => entry.delivery === "pending"),
  ).toHaveLength(2);
  f.calls[0].callbacks.onSteeringApplied(f.steers.map((entry) => entry.id));
  f.calls[0].callbacks.onRun({ ...f.calls[0].run, toolCallCount: 2 });
  f.finish(0);
  await running;
  const messages = f.manager.getSnapshot().active!.messages;
  expect(messages.map((entry) => entry.displayText)).toEqual([
    "Find a paper",
    "It may use an abbreviation",
    "Only the first author",
    "Completed",
  ]);
  expect(messages.filter((entry) => entry.delivery === "applied")).toHaveLength(2);
  expect(left).toHaveBeenCalled();
  expect(right).toHaveBeenCalledTimes(left.mock.calls.length);
});

it("snapshots message attachments instead of aliasing the mutable run context", async () => {
  const f = await fixture();
  const running = f.send("Find a paper");
  f.calls[0].context.refs.items.push({ libraryID: 1, itemKey: "LATER001" });
  expect(f.manager.getSnapshot().active!.messages[0].contextRefs?.items).toEqual([]);
  await f.submit("Use this additional clue");
  f.steers[0].context.refs.items.push({ libraryID: 1, itemKey: "LATER002" });
  expect(f.manager.getSnapshot().active!.messages[1].contextRefs?.items).toEqual([]);
  f.finish(0);
  await running;
});

it("runs queued messages FIFO only after the current task finishes", async () => {
  const f = await fixture();
  const running = f.send("First");
  await f.submit("Second", "queue");
  await f.submit("Third", "queue");
  expect(f.calls).toHaveLength(1);
  const second = f.manager.getSnapshot().queuedMessages[0];
  f.manager.editQueued(second.id, "Edited second");
  f.finish(0);
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1].messages.at(-1).displayText).toBe("Edited second");
  f.finish(1);
  await vi.waitFor(() => expect(f.calls).toHaveLength(3));
  expect(f.calls[2].messages.at(-1).displayText).toBe("Third");
  f.finish(2);
  await running;
  expect(f.manager.getSnapshot().queuedMessages).toEqual([]);
});

it("holds queued work after Stop until the user explicitly resumes", async () => {
  const f = await fixture();
  const running = f.send("First");
  await f.submit("Next", "queue");
  f.manager.stop();
  await running;
  expect(f.calls).toHaveLength(1);
  expect(f.manager.getSnapshot().queuePaused).toBe(true);
  const resumed = f.manager.resumeQueued(profile, "System", limits);
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.finish(1);
  await resumed;
});

it("holds queues after failure rather than starting another automatic run", async () => {
  const f = await fixture();
  const running = f.send("First");
  await f.submit("Next", "queue");
  f.finish(0, "failed");
  await running;
  expect(f.calls).toHaveLength(1);
  expect(f.manager.getSnapshot().queuedMessages).toHaveLength(1);
  expect(f.manager.getSnapshot().queuePaused).toBe(true);
});

it("keeps running results and queued messages attached to their own conversation", async () => {
  const f = await fixture();
  const original = f.manager.getSnapshot().active!.id;
  const running = f.send("Conversation A");
  f.manager.newConversation();
  const next = f.manager.getSnapshot().active!.id;
  await f.submit("Conversation B");
  f.calls[0].callbacks.onAssistantDelta("A progress");
  expect(f.manager.getSnapshot().streamingText).toBe("");
  expect(f.manager.getSnapshot().runningConversationID).toBe(original);
  f.finish(0);
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1].run.conversationID).toBe(next);
  expect(f.repository.get(original)?.messages.at(-1)?.displayText).toBe("Completed");
  f.finish(1);
  await running;
  expect(f.repository.get(next)?.messages.at(0)?.displayText).toBe("Conversation B");
});

it("restores queued text held for review, not keys or transient reader selection", async () => {
  const f = await fixture();
  const running = f.send("First");
  await f.manager.submit(
    "Queued",
    [
      {
        id: "selection",
        kind: "selection",
        label: "Selection",
        ephemeralText: "private ephemeral passage",
      },
    ],
    profile,
    "System",
    limits,
    "queue",
  );
  await f.submit("Pending guidance");
  await f.repository.flush();
  const saved = [...f.store.files.values()].join("\n");
  expect(saved).not.toContain(profile.apiKey);
  expect(saved).not.toContain("private ephemeral passage");
  const restored = await fixture(f.store);
  expect(restored.calls).toHaveLength(0);
  expect(restored.manager.getSnapshot().active?.lastRun?.status).toBe("interrupted");
  expect(restored.manager.getSnapshot().queuedMessages[0].needsReview).toBe(true);
  expect(
    restored.manager.getSnapshot().active?.messages.find((entry) => entry.followUp)
      ?.delivery,
  ).toBe("not-applied");
  await expect(
    restored.manager.resumeQueued(profile, "System", limits),
  ).rejects.toThrow("Reader selection");
  f.manager.stop();
  await running;
});

it("removes a queued message without sending it or losing the current run", async () => {
  const f = await fixture();
  const running = f.send("First");
  await f.submit("Remove", "queue");
  f.manager.removeQueued(f.manager.getSnapshot().queuedMessages[0].id);
  f.finish(0);
  await running;
  expect(f.calls).toHaveLength(1);
  expect(f.manager.getSnapshot().queuedMessages).toEqual([]);
});

it("prevents deletion of a running conversation and safely waits before editing/rerunning", async () => {
  const f = await fixture();
  const running = f.send("First");
  const conversation = f.manager.getSnapshot().active!;
  await expect(f.manager.deleteConversation(conversation.id)).rejects.toThrow("Stop");
  const rerun = f.manager.editAndRerun(
    conversation.messages[0].id,
    "Edited",
    [],
    profile,
    "System",
    limits,
  );
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.finish(1);
  await Promise.all([running, rerun]);
  expect(f.manager.getSnapshot().active?.messages[0].displayText).toBe("Edited");
});
