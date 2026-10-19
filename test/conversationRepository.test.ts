import { describe, expect, it } from "vitest";
import {
  ConversationFileStore,
  ConversationRepository,
} from "../src/core/conversationRepository";

class MemoryStore implements ConversationFileStore {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async read(path: string) {
    const value = this.files.get(path);
    if (value == null) throw new Error("missing");
    return value;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async exists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }
  async move(source: string, destination: string) {
    const value = this.files.get(source);
    if (value == null) throw new Error("missing");
    this.files.set(destination, value);
    this.files.delete(source);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdir(path: string) {
    this.dirs.add(path);
  }
  join(...parts: string[]) {
    return parts.join("/");
  }
}

describe("ConversationRepository", () => {
  it("stores an index separately and restores conversations", async () => {
    const store = new MemoryStore();
    const repository = new ConversationRepository(store, "root");
    await repository.initialize();
    const conversation = repository.create("Test");
    conversation.messages.push({
      id: "m1",
      role: "user",
      displayText: "hello",
      createdAt: new Date().toISOString(),
    });
    repository.update(conversation);
    await repository.flush();
    expect(store.files.get("root/index.json")).toContain("Test");
    const restored = new ConversationRepository(store, "root");
    await restored.initialize();
    expect(restored.get(conversation.id)?.messages[0].displayText).toBe("hello");
  });

  it("marks active runs interrupted and expires approval references", async () => {
    const store = new MemoryStore();
    store.dirs.add("root");
    store.files.set(
      "root/index.json",
      JSON.stringify({
        schemaVersion: 1,
        conversations: [{ id: "c", title: "Chat", createdAt: "x", updatedAt: "x" }],
      }),
    );
    store.files.set(
      "root/conversations/c.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "c",
        title: "Chat",
        createdAt: "x",
        updatedAt: "x",
        messages: [],
        lastRun: {
          id: "r",
          conversationID: "c",
          status: "waiting-approval",
          startedAt: "x",
          toolCallCount: 1,
          events: [],
          pendingBatchID: "b",
        },
      }),
    );
    const repository = new ConversationRepository(store, "root");
    await repository.initialize();
    expect(repository.get("c")?.lastRun?.status).toBe("interrupted");
    expect(repository.get("c")?.lastRun?.pendingBatchID).toBeUndefined();
  });
});
