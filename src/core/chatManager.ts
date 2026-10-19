import { AgentRunner } from "../agent/agentRunner";
import { ConversationRepository } from "./conversationRepository";
import { AvailableContext, ContextManager } from "./contextManager";
import {
  ChatConversation,
  AgentRun,
  ModelProfile,
  PendingWriteBatch,
  StoredMessage,
  SourceReference,
  WriteOperationRecord,
} from "./types";
import { createID, nowISO } from "../utils/ids";
import { WriteExecutor } from "../host/writeExecutor";
import { SearchLearningRepository } from "./searchLearningRepository";

export interface ChatSnapshot {
  conversations: ReturnType<ConversationRepository["list"]>;
  active?: ChatConversation;
  running: boolean;
  streamingText: string;
  pendingBatch?: PendingWriteBatch;
  operations: WriteOperationRecord[];
  status: string;
}

export class ChatManager {
  private listeners = new Set<() => void>();
  private snapshot?: ChatSnapshot;
  private activeID?: string;
  private running = false;
  private streamingText = "";
  private pendingBatch?: PendingWriteBatch;
  private operations: WriteOperationRecord[] = [];
  private status = "Ready";

  constructor(
    private readonly repository: ConversationRepository,
    private readonly contextManager: ContextManager,
    private readonly agentRunner: AgentRunner,
    private readonly writeExecutor: WriteExecutor,
    private readonly searchLearning: SearchLearningRepository,
  ) {}

  async initialize(): Promise<void> {
    await this.repository.initialize();
    const first = this.repository.list()[0];
    this.activeID = first?.id;
    if (!this.activeID) this.activeID = this.repository.create().id;
    this.emit();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot = (): ChatSnapshot => {
    // React's useSyncExternalStore requires referentially stable snapshots
    // between store notifications. Rebuilding this object on every read causes
    // React to enter a render loop even though the store did not change.
    this.snapshot ||= this.buildSnapshot();
    return this.snapshot;
  };
  getServerSnapshot = this.getSnapshot;
  settingsChanged(): void {
    this.emit();
  }
  availableContext(win: _ZoteroTypes.MainWindow): AvailableContext[] {
    return this.contextManager.getAvailable(win);
  }
  selectConversation(id: string): void {
    if (this.repository.get(id)) {
      this.activeID = id;
      this.streamingText = "";
      this.emit();
    }
  }
  newConversation(): void {
    this.activeID = this.repository.create().id;
    this.streamingText = "";
    this.emit();
  }
  renameActive(title: string): void {
    const conversation = this.active();
    conversation.title = title.trim().slice(0, 120) || "New chat";
    this.repository.update(conversation);
    this.emit();
  }
  async deleteActive(): Promise<void> {
    if (!this.activeID) return;
    await this.deleteConversation(this.activeID);
  }
  async deleteConversation(id: string): Promise<void> {
    const deletingActive = this.activeID === id;
    await this.repository.delete(id);
    if (deletingActive)
      this.activeID = this.repository.list()[0]?.id || this.repository.create().id;
    this.emit();
  }
  searchConversations(query: string) {
    return this.repository.list(query);
  }
  exportMarkdown(): string {
    return conversationMarkdown(this.active());
  }

  async markSourceRelevant(messageID: string, sourceID: string): Promise<void> {
    await this.recordSourceFeedback(messageID, sourceID, true);
  }

  async markSourceIrrelevant(messageID: string, sourceID: string): Promise<void> {
    await this.recordSourceFeedback(messageID, sourceID, false);
  }

  private async recordSourceFeedback(
    messageID: string,
    sourceID: string,
    relevant: boolean,
  ): Promise<void> {
    const conversation = this.active();
    const messageIndex = conversation.messages.findIndex(
      (message) => message.id === messageID && message.role === "assistant",
    );
    if (messageIndex < 0) return;
    const message = conversation.messages[messageIndex];
    const source = message.sourceRefs?.find((entry) => entry.sourceID === sourceID);
    if (!source) return;
    const query = [...conversation.messages.slice(0, messageIndex)]
      .reverse()
      .find((entry) => entry.role === "user")?.displayText;
    if (!query) return;
    if (relevant) {
      message.relevantSourceIDs = [
        ...new Set([...(message.relevantSourceIDs || []), sourceID]),
      ];
      message.irrelevantSourceIDs = (message.irrelevantSourceIDs || []).filter(
        (id) => id !== sourceID,
      );
      await this.searchLearning.recordRelevant(query, source.label);
    } else {
      message.irrelevantSourceIDs = [
        ...new Set([...(message.irrelevantSourceIDs || []), sourceID]),
      ];
      message.relevantSourceIDs = (message.relevantSourceIDs || []).filter(
        (id) => id !== sourceID,
      );
      await this.searchLearning.recordIrrelevant(query, source.label);
    }
    this.repository.update(conversation);
    this.status = relevant
      ? "Saved relevant result for future similar searches"
      : "Saved irrelevant result to reduce future topic drift";
    this.emit();
  }

  async send(
    text: string,
    selectedContext: AvailableContext[],
    profile: ModelProfile,
    systemPrompt: string,
    limits: {
      maxToolCalls: number;
      maxAttachments: number;
      developerDiagnostics?: boolean;
    },
  ): Promise<void> {
    if (this.running) throw new Error("Another Agent run is active");
    const conversation = this.active();
    const context = this.contextManager.build(selectedContext);
    const coverageByAttachment = new Map<string, SourceReference>();
    const user: StoredMessage = {
      id: createID("msg"),
      role: "user",
      displayText: text.trim(),
      createdAt: nowISO(),
      contextRefs: context.refs,
    };
    if (!user.displayText) return;
    conversation.messages.push(user);
    if (conversation.messages.length === 1 && conversation.title === "New chat")
      conversation.title = user.displayText.slice(0, 60);
    this.running = true;
    this.streamingText = "";
    this.status = "Agent is running";
    this.repository.update(conversation);
    this.emit();
    const result = await this.agentRunner.run(
      conversation.id,
      conversation.messages,
      context,
      profile,
      systemPrompt,
      limits,
      {
        onRun: (run) => {
          conversation.lastRun = run;
          this.repository.update(conversation);
          this.emit();
        },
        onAssistantDelta: (delta) => {
          this.streamingText += delta;
          this.emit();
        },
        onToolResult: (_result, event) => {
          const coverage = (_result.content as any)?.coverage;
          if (Array.isArray(coverage))
            for (const entry of coverage) {
              if (
                !entry.attachment ||
                !Number.isFinite(entry.cacheChars) ||
                !Number.isFinite(entry.scannedChars)
              )
                continue;
              const key = `${entry.attachment.libraryID}:${entry.attachment.itemKey}`;
              coverageByAttachment.set(key, {
                sourceID: key,
                item: entry.attachment,
                attachment: entry.attachment,
                label: entry.attachment.itemKey,
                field: "fulltext",
                indexState: entry.indexState,
                coverage: {
                  cacheChars: entry.cacheChars,
                  scannedChars: entry.scannedChars,
                  truncated: entry.truncated === true,
                },
              });
            }
          this.status = event.summary;
          this.emit();
        },
        onApproval: (batch) => {
          this.pendingBatch = batch;
          this.status = "Waiting for write approval";
          this.emit();
        },
      },
    );
    if (
      result.answer ||
      result.run.status === "failed" ||
      result.run.status === "cancelled"
    )
      conversation.messages.push({
        id: createID("msg"),
        role: "assistant",
        displayText: result.answer || result.run.error || result.run.status,
        createdAt: nowISO(),
        sourceRefs: result.sources,
        evidenceCoverage: [...coverageByAttachment.values()],
        agentEvents: result.run.events,
        protocolHistory: result.protocolHistory?.length
          ? result.protocolHistory
          : undefined,
        error: result.run.status === "failed",
      });
    conversation.lastRun = result.run;
    this.running = false;
    this.streamingText = "";
    this.status = finalRunStatus(result.run);
    this.repository.update(conversation);
    this.emit();
  }

  stop(): void {
    this.agentRunner.cancel();
  }
  async editAndRerun(
    messageID: string,
    text: string,
    selectedContext: AvailableContext[],
    profile: ModelProfile,
    systemPrompt: string,
    limits: {
      maxToolCalls: number;
      maxAttachments: number;
      developerDiagnostics?: boolean;
    },
  ): Promise<void> {
    this.stop();
    const conversation = this.active();
    const index = conversation.messages.findIndex(
      (message) => message.id === messageID && message.role === "user",
    );
    if (index < 0) return;
    conversation.messages = conversation.messages.slice(0, index);
    this.pendingBatch = undefined;
    this.repository.update(conversation);
    await this.send(text, selectedContext, profile, systemPrompt, limits);
  }
  async regenerate(
    selectedContext: AvailableContext[],
    profile: ModelProfile,
    systemPrompt: string,
    limits: {
      maxToolCalls: number;
      maxAttachments: number;
      developerDiagnostics?: boolean;
    },
  ): Promise<void> {
    const conversation = this.active();
    const lastUser = [...conversation.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (lastUser)
      await this.editAndRerun(
        lastUser.id,
        lastUser.displayText,
        selectedContext,
        profile,
        systemPrompt,
        limits,
      );
  }
  async approve(selectedIDs?: string[]): Promise<void> {
    if (!this.pendingBatch) return;
    const record = await this.writeExecutor.execute(this.pendingBatch, selectedIDs);
    this.operations.push(record);
    this.pendingBatch = undefined;
    this.status = "Write batch executed";
    this.emit();
  }
  reject(): void {
    if (!this.pendingBatch) return;
    this.writeExecutor.reject(this.pendingBatch);
    this.pendingBatch = undefined;
    this.status = "Write batch rejected";
    this.emit();
  }
  async undo(recordID: string): Promise<void> {
    const record = this.operations.find((entry) => entry.id === recordID);
    if (!record) return;
    await this.writeExecutor.undo(record);
    this.status = "Write batch undone";
    this.emit();
  }
  async flush(): Promise<void> {
    await Promise.all([this.repository.flush(), this.searchLearning.flush()]);
  }

  private active(): ChatConversation {
    if (!this.activeID) this.activeID = this.repository.create().id;
    const conversation = this.repository.get(this.activeID);
    if (!conversation) throw new Error("Active conversation is unavailable");
    return conversation;
  }
  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ChatSnapshot {
    return {
      conversations: this.repository.list(),
      active: this.activeID ? this.repository.get(this.activeID) : undefined,
      running: this.running,
      streamingText: this.streamingText,
      pendingBatch: this.pendingBatch,
      operations: [...this.operations],
      status: this.status,
    };
  }
}

export function conversationMarkdown(conversation: ChatConversation): string {
  return `# ${conversation.title}\n\n${conversation.messages
    .map((message) => {
      const sources = message.sourceRefs?.length
        ? `\n\n### Sources\n\n${message.sourceRefs
            .map((source) => `- ${source.label} (${source.sourceID})`)
            .join("\n")}`
        : "";
      const exportableEvents = (message.agentEvents || []).filter(
        (event) => event.type !== "provider-reasoning",
      );
      const events = exportableEvents.length
        ? `\n\n<details>\n<summary>${exportableEvents.length} agent events</summary>\n\n${exportableEvents
            .map((event) => `- ${event.summary}`)
            .join("\n")}\n\n</details>`
        : "";
      return `## ${message.role === "user" ? "You" : message.role === "assistant" ? "ZaiChat" : "Tool"}\n\n${message.displayText}${sources}${events}`;
    })
    .join("\n\n")}`;
}

export function finalRunStatus(run: AgentRun): string {
  if (run.status !== "completed") return run.status;
  return run.events.some((event) => event.type === "error")
    ? "Completed with tool errors"
    : "Ready";
}
