import { ChatConversation, ConversationIndexEntry } from "./types";
import { createID, nowISO } from "../utils/ids";
import { cloneJSON } from "../utils/clone";

interface PersistedIndex {
  schemaVersion: 1;
  conversations: ConversationIndexEntry[];
}

export interface ConversationFileStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  join(...parts: string[]): string;
}

export class ConversationRepository {
  private index: ConversationIndexEntry[] = [];
  private readonly conversations = new Map<string, ChatConversation>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConversationFileStore,
    private readonly root: string,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      this.store.mkdir(this.root),
      this.store.mkdir(this.dir("conversations")),
      this.store.mkdir(this.dir("backups")),
    ]);
    await this.loadIndex();
    for (const entry of this.index) await this.loadConversation(entry);
  }

  list(search = ""): ConversationIndexEntry[] {
    const query = search.trim().toLocaleLowerCase();
    return [...this.index]
      .filter(
        (entry) =>
          !query ||
          entry.title.toLocaleLowerCase().includes(query) ||
          this.conversations
            .get(entry.id)
            ?.messages.some((message) =>
              message.displayText.toLocaleLowerCase().includes(query),
            ),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): ChatConversation | undefined {
    const value = this.conversations.get(id);
    return value ? cloneJSON(value) : undefined;
  }

  create(title = "New chat"): ChatConversation {
    const timestamp = nowISO();
    const conversation: ChatConversation = {
      schemaVersion: 1,
      id: createID("chat"),
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    this.conversations.set(conversation.id, conversation);
    this.index.push(this.toIndexEntry(conversation));
    this.enqueueSave(conversation);
    return cloneJSON(conversation);
  }

  update(conversation: ChatConversation): void {
    const copy = cloneJSON({ ...conversation, updatedAt: nowISO() });
    this.conversations.set(copy.id, copy);
    const index = this.index.findIndex((entry) => entry.id === copy.id);
    const entry = this.toIndexEntry(copy);
    if (index >= 0) this.index[index] = entry;
    else this.index.push(entry);
    this.enqueueSave(copy);
  }

  async delete(id: string): Promise<void> {
    this.conversations.delete(id);
    this.index = this.index.filter((entry) => entry.id !== id);
    await this.flush();
    const file = this.conversationPath(id);
    if (await this.store.exists(file)) await this.store.remove(file);
    await this.atomicWrite(
      this.indexPath(),
      JSON.stringify(this.persistedIndex(), null, 2),
    );
  }

  async clear(): Promise<void> {
    for (const entry of [...this.index]) await this.delete(entry.id);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueSave(conversation: ChatConversation): void {
    const snapshot = cloneJSON(conversation);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.atomicWrite(
        this.conversationPath(snapshot.id),
        JSON.stringify(snapshot, null, 2),
      );
      await this.atomicWrite(
        this.indexPath(),
        JSON.stringify(this.persistedIndex(), null, 2),
      );
    });
  }

  private async loadIndex(): Promise<void> {
    const path = this.indexPath();
    if (!(await this.store.exists(path))) return;
    try {
      const parsed = JSON.parse(await this.store.read(path)) as PersistedIndex;
      this.index =
        parsed.schemaVersion === 1 && Array.isArray(parsed.conversations)
          ? parsed.conversations
          : [];
    } catch {
      await this.backupCorrupt(path, "index");
      this.index = [];
    }
  }

  private async loadConversation(entry: ConversationIndexEntry): Promise<void> {
    const path = this.conversationPath(entry.id);
    try {
      const parsed = JSON.parse(await this.store.read(path)) as ChatConversation;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages))
        throw new Error("Unsupported conversation schema");
      if (
        parsed.lastRun &&
        ["running", "waiting-approval", "waiting-user"].includes(parsed.lastRun.status)
      ) {
        parsed.lastRun = {
          ...parsed.lastRun,
          status: "interrupted",
          finishedAt: nowISO(),
          pendingBatchID: undefined,
        };
      }
      for (const message of parsed.messages)
        if (message.delivery === "pending") message.delivery = "not-applied";
      for (const message of parsed.queuedMessages || []) message.needsReview = true;
      this.conversations.set(entry.id, parsed);
    } catch {
      entry.unreadable = true;
      if (await this.store.exists(path)) await this.backupCorrupt(path, entry.id);
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temp = `${path}.tmp`;
    const previous = `${path}.bak`;
    await this.store.write(temp, content);
    if (await this.store.exists(path)) {
      if (await this.store.exists(previous)) await this.store.remove(previous);
      await this.store.move(path, previous);
    }
    await this.store.move(temp, path);
  }

  private async backupCorrupt(path: string, label: string): Promise<void> {
    const destination = this.dir("backups", `${label}-${Date.now()}.corrupt.json`);
    await this.store.move(path, destination);
  }

  private toIndexEntry(conversation: ChatConversation): ConversationIndexEntry {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  private persistedIndex(): PersistedIndex {
    return { schemaVersion: 1, conversations: this.index };
  }
  private dir(...parts: string[]): string {
    return this.store.join(this.root, ...parts);
  }
  private indexPath(): string {
    return this.dir("index.json");
  }
  private conversationPath(id: string): string {
    return this.dir("conversations", `${id}.json`);
  }
}
