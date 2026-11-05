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
  ContextEnvelope,
  PendingUserQuestion,
  QueuedChatMessage,
} from "./types";
import { createID, nowISO } from "../utils/ids";
import { WriteExecutor } from "../host/writeExecutor";
import { SearchLearningRepository } from "./searchLearningRepository";
import { cloneJSON } from "../utils/clone";

export interface ChatSnapshot {
  runningConversationID?: string;
  question?: PendingUserQuestion;
  queuedMessages: QueuedChatMessage[];
  queuePaused: boolean;
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
  private runningConversation?: ChatConversation;
  private question?: PendingUserQuestion;
  private queuePaused = false;
  private queuedRuntime = new Map<
    string,
    {
      context: ContextEnvelope;
      profile: ModelProfile;
      systemPrompt: string;
      limits: RunLimits;
    }
  >();
  private runningCompletion?: Promise<void>;

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
    const run = this.repository.get(this.activeID)?.lastRun;
    this.status = run ? finalRunStatus(run) : "Ready";
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
      if (!this.running) {
        this.streamingText = "";
        const run = this.repository.get(id)?.lastRun;
        this.status = run ? finalRunStatus(run) : "Ready";
      }
      this.emit();
    }
  }
  newConversation(): void {
    this.activeID = this.repository.create().id;
    if (!this.running) {
      this.streamingText = "";
      this.status = "Ready";
    }
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
    if (this.runningConversation?.id === id)
      throw new Error("Stop the running conversation before deleting it");
    for (const queued of this.repository.get(id)?.queuedMessages || [])
      this.queuedRuntime.delete(queued.id);
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

  async submit(
    text: string,
    selected: AvailableContext[],
    profile: ModelProfile,
    systemPrompt: string,
    limits: RunLimits,
    mode: "steer" | "queue" = "steer",
  ): Promise<void> {
    if (!text.trim()) return;
    if (!this.running) return this.send(text, selected, profile, systemPrompt, limits);
    const conversation = this.active();
    const context = this.contextManager.build(selected);
    if (mode === "steer" && this.runningConversation?.id === conversation.id) {
      const message: StoredMessage = {
        id: createID("msg"),
        role: "user",
        displayText: text.trim(),
        createdAt: nowISO(),
        contextRefs: cloneJSON(context.refs),
        delivery: "pending",
        followUp: this.question ? "clarification" : "steer",
      };
      this.agentRunner.steer({ id: message.id, text: message.displayText, context });
      conversation.messages.push(message);
      this.repository.update(conversation);
      this.status = "Guidance pending";
      this.emit();
      return;
    }
    if (
      text.length > 6000 ||
      this.repository
        .list()
        .reduce(
          (count, entry) =>
            count + (this.repository.get(entry.id)?.queuedMessages?.length || 0),
          0,
        ) >= 20
    )
      throw new Error("Queue accepts at most 20 messages of 6000 characters each");
    const queued: QueuedChatMessage = {
      id: createID("queued"),
      text: text.trim(),
      createdAt: nowISO(),
      contextRefs: cloneJSON(context.refs),
    };
    (conversation.queuedMessages ||= []).push(queued);
    this.queuedRuntime.set(queued.id, {
      context,
      profile: { ...profile },
      systemPrompt,
      limits: { ...limits },
    });
    this.repository.update(conversation);
    this.emit();
  }

  editQueued(id: string, text: string): void {
    if (!text.trim() || text.length > 6000)
      throw new Error("Message must contain 1–6000 characters");
    const conversation = this.active();
    const queued = conversation.queuedMessages?.find((entry) => entry.id === id);
    if (!queued) return;
    queued.text = text.trim();
    this.repository.update(conversation);
    this.emit();
  }

  removeQueued(id: string): void {
    const conversation = this.active();
    conversation.queuedMessages = (conversation.queuedMessages || []).filter(
      (entry) => entry.id !== id,
    );
    this.queuedRuntime.delete(id);
    this.repository.update(conversation);
    this.emit();
  }

  async resumeQueued(
    profile: ModelProfile,
    systemPrompt: string,
    limits: RunLimits,
  ): Promise<void> {
    if (this.pendingBatch) throw new Error("Resolve the pending write approval first");
    const conversation = this.active();
    for (const queued of conversation.queuedMessages || []) {
      if (!this.queuedRuntime.has(queued.id)) {
        if (queued.contextRefs.hasEphemeralSelection)
          throw new Error(
            "Reader selection was not saved. Reattach it before resending this queued message",
          );
        this.queuedRuntime.set(queued.id, {
          context: { refs: queued.contextRefs },
          profile: { ...profile },
          systemPrompt,
          limits,
        });
      }
      const runtime = this.queuedRuntime.get(queued.id)!;
      this.queuedRuntime.set(queued.id, {
        ...runtime,
        profile: { ...profile },
        systemPrompt,
        limits: { ...limits },
      });
      queued.needsReview = false;
    }
    this.queuePaused = false;
    this.repository.update(conversation);
    this.emit();
    await this.drainQueue();
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
    preparedContext?: ContextEnvelope,
    conversationID?: string,
  ): Promise<void> {
    if (this.running) throw new Error("Another Agent run is active");
    const conversation = conversationID
      ? this.repository.get(conversationID)
      : this.active();
    if (!conversation) throw new Error("Conversation is unavailable");
    const context = preparedContext || this.contextManager.build(selectedContext);
    const coverageByAttachment = new Map<string, SourceReference>();
    const user: StoredMessage = {
      id: createID("msg"),
      role: "user",
      displayText: text.trim(),
      createdAt: nowISO(),
      contextRefs: cloneJSON(context.refs),
    };
    if (!user.displayText) return;
    if (this.pendingBatch) {
      this.writeExecutor.reject(this.pendingBatch);
      this.pendingBatch = undefined;
    }
    conversation.messages.push(user);
    if (conversation.messages.length === 1 && conversation.title === "New chat")
      conversation.title = user.displayText.slice(0, 60);
    this.running = true;
    this.runningConversation = conversation;
    let finishRunning!: () => void;
    this.runningCompletion = new Promise<void>((resolve) => {
      finishRunning = resolve;
    });
    this.streamingText = "";
    this.status = "Agent is running";
    this.repository.update(conversation);
    this.emit();
    try {
      const result = await this.agentRunner.run(
        conversation.id,
        conversation.messages.filter(
          (message) => !message.delivery || message.delivery === "applied",
        ),
        context,
        profile,
        systemPrompt,
        limits,
        {
          onAssistantReset: () => {
            this.streamingText = "";
            this.emit();
          },
          onSteeringApplied: (ids) => {
            for (const message of conversation.messages)
              if (ids.includes(message.id)) message.delivery = "applied";
            this.repository.update(conversation);
            this.emit();
          },
          onQuestion: (question) => {
            this.question = question;
            this.status = question ? "Waiting for your reply" : "Agent is running";
            if (
              question &&
              !conversation.messages.some(
                (message) => message.questionID === question.id,
              )
            )
              conversation.messages.push({
                id: createID("msg"),
                role: "assistant",
                displayText: question.question,
                createdAt: nowISO(),
                questionID: question.id,
              });
            this.repository.update(conversation);
            this.emit();
          },
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
      if (result.run.status !== "completed") this.queuePaused = true;
      this.status = finalRunStatus(result.run);
    } catch (error) {
      this.queuePaused = true;
      this.status = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      for (const message of conversation.messages)
        if (message.delivery === "pending") message.delivery = "not-applied";
      this.running = false;
      this.runningConversation = undefined;
      this.runningCompletion = undefined;
      this.question = undefined;
      this.streamingText = "";
      this.repository.update(conversation);
      this.emit();
      finishRunning();
    }
    await this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.running || this.queuePaused || this.pendingBatch) return;
    const next = this.repository
      .list()
      .flatMap((entry) =>
        (this.repository.get(entry.id)?.queuedMessages || []).map((message) => ({
          message,
          conversationID: entry.id,
        })),
      )
      .filter(
        (entry) =>
          !entry.message.needsReview && this.queuedRuntime.has(entry.message.id),
      )
      .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))[0];
    if (!next || next.message.needsReview) return;
    const runtime = this.queuedRuntime.get(next.message.id);
    if (!runtime) return;
    const conversation = this.repository.get(next.conversationID)!;
    conversation.queuedMessages = conversation.queuedMessages!.filter(
      (entry) => entry.id !== next.message.id,
    );
    this.queuedRuntime.delete(next.message.id);
    this.repository.update(conversation);
    await this.send(
      next.message.text,
      [],
      runtime.profile,
      runtime.systemPrompt,
      runtime.limits,
      runtime.context,
      conversation.id,
    );
  }

  stop(): void {
    this.queuePaused = true;
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
    const runningCompletion = this.runningCompletion;
    this.stop();
    await runningCompletion;
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
    await this.runningCompletion;
    await Promise.all([this.repository.flush(), this.searchLearning.flush()]);
  }

  private active(): ChatConversation {
    if (!this.activeID) this.activeID = this.repository.create().id;
    const conversation =
      this.runningConversation?.id === this.activeID
        ? this.runningConversation
        : this.repository.get(this.activeID);
    if (!conversation) throw new Error("Active conversation is unavailable");
    return conversation;
  }
  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ChatSnapshot {
    return {
      runningConversationID: this.runningConversation?.id,
      question:
        this.runningConversation?.id === this.activeID ? this.question : undefined,
      queuedMessages: this.activeID
        ? this.repository.get(this.activeID)?.queuedMessages || []
        : [],
      queuePaused: this.queuePaused,
      conversations: this.repository.list(),
      active: this.activeID ? this.repository.get(this.activeID) : undefined,
      running: this.running,
      streamingText:
        this.runningConversation?.id === this.activeID ? this.streamingText : "",
      pendingBatch: this.pendingBatch,
      operations: [...this.operations],
      status: this.status,
    };
  }
}

interface RunLimits {
  maxToolCalls: number;
  maxAttachments: number;
  developerDiagnostics?: boolean;
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
  const errors = run.events.filter((event) => event.type === "error");
  const acceptedIndex = run.events.findLastIndex(
    (event) =>
      event.type === "tool-result" &&
      event.name === "finish_answer" &&
      event.status === "completed",
  );
  const repairMessages = new Set([
    "Citation repair needed: use current evidence IDs",
    "Answer needs evidence/qualification repair",
    "Answer citation repair requires a contextual source: select supporting source IDs",
  ]);
  const repaired = (event: AgentRun["events"][number]) =>
    event.name === "finish_answer" &&
    repairMessages.has(event.summary) &&
    acceptedIndex > run.events.indexOf(event);
  if (errors.some((event) => !repaired(event))) return "Completed with tool errors";
  return errors.length ? "Completed after answer repair" : "Ready";
}
