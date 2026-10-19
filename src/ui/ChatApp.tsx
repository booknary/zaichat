import React, { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { groupSources, evidenceGroups } from "./sourceGroups";
import { ChatManager } from "../core/chatManager";
import { AvailableContext } from "../core/contextManager";
import { ModelProfile, SourceReference } from "../core/types";
import { compactAgentEvents } from "./agentEvents";
import { evidenceCoverage } from "./evidenceCoverage";
import { MessageText } from "./MessageText";
import { ModelPicker, ModelSelection } from "./ModelPicker";
import { conversationUsage } from "../agent/tokenUsage";
import { useMenuText } from "./menuLocale";

export function ChatApp({
  manager,
  window: win,
  getProfile,
  getSettings,
  onExport,
  onLocate,
  onOpen,
  onOpenSettings,
  loadModels,
  onSelectModel,
  onToggleDisplay,
}: {
  manager: ChatManager;
  window: _ZoteroTypes.MainWindow;
  getProfile: () => ModelProfile | undefined;
  getSettings: () => {
    systemPrompt: string;
    maxToolCalls: number;
    maxAttachments: number;
    developerDiagnostics?: boolean;
  };
  onExport: (markdown: string, suggestedName: string) => void | Promise<void>;
  onLocate: (source: SourceReference) => void;
  onOpen: (source: SourceReference) => void;
  onOpenSettings: () => void;
  loadModels?: () => Promise<string[]>;
  onSelectModel?: (value: ModelSelection) => void;
  onToggleDisplay?: () => void;
}) {
  const t = useMenuText();
  const shellRef = useRef<HTMLDivElement>(null);
  const snapshot = useSyncExternalStore(
    manager.subscribe.bind(manager),
    manager.getSnapshot,
    manager.getServerSnapshot,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [selectedContext, setSelectedContext] = useState<AvailableContext[]>([]);
  const [contextTick, setContextTick] = useState(0);
  const available = useMemo(
    () => manager.availableContext(win),
    [manager, win, contextTick, snapshot.active?.id],
  );
  const conversations = query
    ? manager.searchConversations(query)
    : snapshot.conversations;
  const profile = getProfile();
  const usage = conversationUsage(snapshot.active);

  const send = async () => {
    const selectedProfile = getProfile();
    if (!selectedProfile) {
      onOpenSettings();
      return;
    }
    const value = draft;
    setDraft("");
    try {
      await manager.send(
        value,
        selectedContext,
        selectedProfile,
        getSettings().systemPrompt,
        getSettings(),
      );
    } catch (error) {
      win.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const rerun = async (messageID: string, current: string) => {
    const value = win.prompt(t("Edit message"), current);
    const selectedProfile = getProfile();
    if (value != null && selectedProfile)
      await manager.editAndRerun(
        messageID,
        value,
        selectedContext,
        selectedProfile,
        getSettings().systemPrompt,
        getSettings(),
      );
  };

  return (
    <div className="zaichat-shell" ref={shellRef}>
      <div className="zaichat-header">
        <img
          className="zaichat-brand-icon"
          src={`${rootURI}content/icons/icon32.png`}
          alt="ZaiChat"
        />
        <button
          className="zaichat-icon-button"
          title={t("Chat history")}
          aria-label={t("Chat history")}
          onClick={() => setHistoryOpen((value) => !value)}
        >
          ☰
        </button>
        <div className="zaichat-heading">
          <strong>
            {!snapshot.active?.title || snapshot.active.title === "New chat"
              ? t("New chat")
              : snapshot.active.title}
          </strong>
          <button
            disabled={snapshot.running}
            onClick={() =>
              profile && onSelectModel ? setModelOpen(true) : onOpenSettings()
            }
          >
            {profile
              ? `${profile.model} · ${profile.reasoningEnabled ? t(profile.reasoningEffort) : t("思考关闭")} ▾`
              : t("配置模型")}
          </button>
        </div>
        <button
          className="zaichat-icon-button"
          title={t("Rename")}
          aria-label={t("Rename conversation")}
          onClick={() => {
            const title = win.prompt(
              t("Conversation title"),
              snapshot.active?.title || "",
            );
            if (title != null) manager.renameActive(title);
          }}
        >
          ✎
        </button>
        <button
          className="zaichat-icon-button"
          title={t("New chat")}
          aria-label={t("New chat")}
          onClick={() => manager.newConversation()}
        >
          ＋
        </button>
        {onToggleDisplay && (
          <button
            className="zaichat-icon-button"
            title={t("切换侧栏 / 独立窗口")}
            aria-label={t("切换显示方式")}
            onClick={onToggleDisplay}
          >
            ▣
          </button>
        )}
      </div>

      <div className="zaichat-body">
        <div className="zaichat-main">
          <div className="zaichat-messages">
            {!snapshot.active?.messages.length && (
              <div className="zaichat-empty-state">
                <img src={`${rootURI}content/icons/icon48.png`} alt="" />
                <strong>{t("Ask your library")}</strong>
                <p>
                  {t("Find, compare, summarize, or organize papers in My Library.")}
                </p>
                {!profile && (
                  <button onClick={onOpenSettings}>{t("Configure a model")}</button>
                )}
              </div>
            )}
            {snapshot.active?.messages.map((message) => (
              <div
                key={message.id}
                className={`zaichat-message ${message.error ? "zaichat-error" : ""}`}
                data-role={message.role}
              >
                <div className="zaichat-message-bubble">
                  <div className="zaichat-message-label">
                    {message.role === "user" ? t("你") : "ZaiChat"}
                  </div>
                  {message.role === "assistant" ? (
                    <MessageText
                      text={message.displayText}
                      sources={message.sourceRefs}
                      onSource={(source) => {
                        const element = shellRef.current?.ownerDocument?.getElementById(
                          `evidence-${message.id}-${source.sourceID}`,
                        );
                        if (!element || !source.snippet) {
                          onLocate(source);
                          return;
                        }
                        const details = element.closest("details");
                        if (details) details.setAttribute("open", "");
                        element.scrollIntoView({ block: "center" });
                        (element as HTMLElement).focus();
                      }}
                    />
                  ) : (
                    <div>{message.displayText}</div>
                  )}
                </div>
                {Boolean(message.evidenceCoverage?.length) && (
                  <details>
                    <summary>{t("本轮全文读取范围（插件记录）")}</summary>
                    {groupSources(message.evidenceCoverage || []).map((sources) => (
                      <p
                        key={`${sources[0].item.libraryID}:${sources[0].item.itemKey}`}
                      >
                        {sources[0].label}:{" "}
                        {[
                          ...new Set(
                            sources
                              .map((source) => evidenceCoverage(source, t))
                              .filter(Boolean),
                          ),
                        ].join("；")}
                      </p>
                    ))}
                  </details>
                )}
                {message.sourceRefs?.length ? (
                  <div className="zaichat-sources">
                    {groupSources(message.sourceRefs).map((sources) => (
                      <SourceCard
                        key={`${sources[0].item.libraryID}:${sources[0].item.itemKey}`}
                        source={sources[0]}
                        sources={sources}
                        allSources={message.sourceRefs}
                        anchorPrefix={`evidence-${message.id}-`}
                        onLocate={onLocate}
                        onOpen={onOpen}
                      />
                    ))}
                  </div>
                ) : null}
                {message.agentEvents?.some(
                  (event) => !["diagnostic", "provider-reasoning"].includes(event.type),
                ) ? (
                  <details className="zaichat-agent-events">
                    <summary>
                      {
                        message.agentEvents.filter(
                          (event) =>
                            !["diagnostic", "provider-reasoning"].includes(event.type),
                        ).length
                      }{" "}
                      {t("agent events")}
                    </summary>
                    <button
                      className="zaichat-copy-events"
                      onClick={() =>
                        void copyText(
                          win,
                          compactAgentEvents(
                            (message.agentEvents || []).filter(
                              (event) =>
                                !["diagnostic", "provider-reasoning"].includes(
                                  event.type,
                                ),
                            ),
                          )
                            .map((event) => event.summary)
                            .join("\n"),
                        )
                      }
                    >
                      {t("Copy events")}
                    </button>
                    <div className="zaichat-agent-event-text">
                      {compactAgentEvents(
                        message.agentEvents.filter(
                          (event) =>
                            !["diagnostic", "provider-reasoning"].includes(event.type),
                        ),
                      ).map((event) => (
                        <div key={event.id}>{event.summary}</div>
                      ))}
                    </div>
                  </details>
                ) : null}
                {getSettings().developerDiagnostics &&
                message.agentEvents?.some((event) =>
                  ["diagnostic", "provider-reasoning"].includes(event.type),
                ) ? (
                  <DeveloperDiagnostics
                    win={win}
                    events={message.agentEvents.filter((event) =>
                      ["diagnostic", "provider-reasoning"].includes(event.type),
                    )}
                  />
                ) : null}
                {message.role === "user" && !snapshot.running && (
                  <div className="zaichat-message-actions">
                    <button onClick={() => rerun(message.id, message.displayText)}>
                      {t("编辑并重试")}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {snapshot.streamingText && (
              <div className="zaichat-message" data-role="assistant">
                <div className="zaichat-message-bubble">
                  <div className="zaichat-message-label">ZaiChat</div>
                  <MessageText text={snapshot.streamingText} />
                </div>
              </div>
            )}
            {snapshot.pendingBatch && (
              <ApprovalCard manager={manager} batch={snapshot.pendingBatch} />
            )}
            {snapshot.operations
              .filter((record) => record.status === "executed")
              .map((record) => (
                <div key={record.id} className="zaichat-card">
                  <span>{t("Write completed")}</span>{" "}
                  <button onClick={() => manager.undo(record.id)}>{t("Undo")}</button>
                </div>
              ))}
          </div>

          <div className="zaichat-status">
            <span className="zaichat-status-dot" data-running={snapshot.running} />
            <span>{t(snapshot.status)}</span>
            <span className="zaichat-status-model">
              {profile
                ? t(
                    {
                      auto: "Auto",
                      "native-tools": "Native tools",
                      "json-actions": "Strict JSON actions",
                    }[profile.protocol],
                  )
                : t("No model")}
            </span>
          </div>

          <div
            className="zaichat-token-usage"
            title={t(
              "本对话保留记录中，已完成请求由提供商报告的输入+输出累计；不是当前上下文大小或账单。旧记录、失败请求及未报告用量的请求可能缺失。",
            )}
          >
            {usage.reported
              ? t("Reported {total} tokens (input {input} / output {output})", {
                  total: usage.totalTokens.toLocaleString(),
                  input: usage.promptTokens.toLocaleString(),
                  output: usage.completionTokens.toLocaleString(),
                })
              : t("Token 用量：尚无提供商报告")}
            {usage.missing
              ? ` · ${t("{count} unreported requests", { count: usage.missing })}`
              : ""}
          </div>
          <div className="zaichat-context-bar">
            <button
              className="zaichat-context-button"
              aria-label={t("Choose context")}
              onClick={() => setContextOpen(true)}
            >
              ＋ {t("Context")}
              {selectedContext.length ? ` (${selectedContext.length})` : ""}
            </button>
            <span className="zaichat-context-summary">
              {selectedContext.length
                ? selectedContext.map((entry) => entry.label).join(", ")
                : t("No explicit context attached")}
            </span>
          </div>

          <div className="zaichat-composer">
            <textarea
              value={draft}
              disabled={snapshot.running}
              placeholder={t("描述你想找的文献，或提出一个问题…")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="zaichat-composer-actions">
              <span className="zaichat-input-hint">
                {t("Enter 发送 · Shift+Enter 换行")}
              </span>
              {snapshot.running ? (
                <button onClick={() => manager.stop()}>{t("Stop")}</button>
              ) : (
                <button
                  className="zaichat-send-button zaichat-primary-button"
                  disabled={!draft.trim()}
                  onClick={() => void send()}
                >
                  {t("Send")} ↑
                </button>
              )}
              {!snapshot.running &&
              snapshot.active?.messages.some((message) => message.role === "user") ? (
                <button
                  className="zaichat-icon-button"
                  title={t("Regenerate")}
                  aria-label={t("Regenerate")}
                  onClick={() => {
                    const selectedProfile = getProfile();
                    if (selectedProfile)
                      void manager.regenerate(
                        selectedContext,
                        selectedProfile,
                        getSettings().systemPrompt,
                        getSettings(),
                      );
                  }}
                >
                  ↻
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {modelOpen && profile && loadModels && onSelectModel && (
        <ModelPicker
          profile={profile}
          loadModels={loadModels}
          onSave={onSelectModel}
          onClose={() => setModelOpen(false)}
        />
      )}
      {historyOpen && (
        <div
          className="zaichat-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setHistoryOpen(false);
          }}
        >
          <div
            className="zaichat-dialog zaichat-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("Chat history")}
          >
            <div className="zaichat-dialog-header">
              <strong>{t("Chat history")}</strong>
              <button
                aria-label={t("Close chat history")}
                onClick={() => setHistoryOpen(false)}
              >
                ×
              </button>
            </div>
            <input
              className="zaichat-dialog-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search chats")}
            />
            <div className="zaichat-dialog-list">
              {conversations.map((conversation) => (
                <div key={conversation.id} className="zaichat-history-row">
                  <button
                    className="zaichat-history-item"
                    aria-current={conversation.id === snapshot.active?.id}
                    onClick={() => {
                      manager.selectConversation(conversation.id);
                      setHistoryOpen(false);
                    }}
                  >
                    {conversation.unreadable ? "⚠ " : ""}
                    {conversation.title === "New chat"
                      ? t("New chat")
                      : conversation.title}
                  </button>
                  <button
                    className="zaichat-history-delete"
                    aria-label={t("Delete {title}", { title: conversation.title })}
                    title={t("Delete conversation")}
                    onClick={async () => {
                      if (
                        win.confirm(
                          t("Delete conversation “{title}”?", {
                            title: conversation.title,
                          }),
                        )
                      )
                        await manager.deleteConversation(conversation.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="zaichat-dialog-actions">
              <button
                onClick={() =>
                  void onExport(
                    manager.exportMarkdown(),
                    `${safeFilename(snapshot.active?.title || "zaichat-conversation")}.md`,
                  )
                }
              >
                {t("Export Markdown")}
              </button>
            </div>
          </div>
        </div>
      )}

      {contextOpen && (
        <div
          className="zaichat-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setContextOpen(false);
          }}
        >
          <div
            className="zaichat-dialog zaichat-context-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("Choose context")}
          >
            <div className="zaichat-dialog-header">
              <div>
                <strong>{t("Attach context")}</strong>
                <span>{t("Only checked items are sent with your next message.")}</span>
              </div>
              <button
                aria-label={t("Close context")}
                onClick={() => setContextOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="zaichat-dialog-list zaichat-context-list">
              {available.length ? (
                available.map((entry) => {
                  const selected = selectedContext.some(
                    (value) => value.id === entry.id,
                  );
                  return (
                    <label key={entry.id} className="zaichat-context-option">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                          setSelectedContext((values) =>
                            selected
                              ? values.filter((value) => value.id !== entry.id)
                              : [...values, entry],
                          )
                        }
                      />
                      <span>
                        <strong>{contextKindLabel(entry.kind, t)}</strong>
                        {entry.label}
                      </span>
                    </label>
                  );
                })
              ) : (
                <p className="zaichat-dialog-empty">
                  {t(
                    "Select an item, collection, annotation, or reader text in Zotero, then refresh this list.",
                  )}
                </p>
              )}
            </div>
            <div className="zaichat-dialog-actions">
              <button onClick={() => setContextTick((value) => value + 1)}>
                {t("Refresh")}
              </button>
              <button
                disabled={!selectedContext.length}
                onClick={() => setSelectedContext([])}
              >
                {t("Clear")}
              </button>
              <button
                className="zaichat-primary-button"
                onClick={() => setContextOpen(false)}
              >
                {t("Done")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DeveloperDiagnostics({
  win,
  events,
}: {
  win: _ZoteroTypes.MainWindow;
  events: import("../core/types").AgentEvent[];
}) {
  const t = useMenuText();
  const reasoning = events.filter(
    (event) => event.type === "provider-reasoning" && event.reasoningContent,
  );
  const structured = events.filter((event) => event.type === "diagnostic");
  const copyValue = [
    ...structured.map(
      (event) => `${event.summary}\n${JSON.stringify(event.details || {}, null, 2)}`,
    ),
    ...reasoning.map((event) => `${event.summary}\n${event.reasoningContent || ""}`),
  ].join("\n\n");
  return (
    <details className="zaichat-developer-diagnostics">
      <summary>{t("Developer diagnostics")}</summary>
      <button onClick={() => void copyText(win, copyValue)}>
        {t("Copy diagnostics")}
      </button>
      {structured.length ? (
        <details>
          <summary>
            {t("Structured Agent trace")} ({structured.length})
          </summary>
          {structured.map((event) => (
            <div key={event.id} className="zaichat-diagnostic-record">
              <strong>{event.summary}</strong>
              <pre>{JSON.stringify(event.details || {}, null, 2)}</pre>
            </div>
          ))}
        </details>
      ) : null}
      {reasoning.map((event) => (
        <details key={event.id} className="zaichat-provider-reasoning">
          <summary>{t("Model reasoning (provider-returned)")}</summary>
          <button onClick={() => void copyText(win, event.reasoningContent || "")}>
            {t("Copy reasoning")}
          </button>
          <pre>{event.reasoningContent}</pre>
        </details>
      ))}
    </details>
  );
}

function contextKindLabel(
  kind: AvailableContext["kind"],
  t: ReturnType<typeof useMenuText>,
): string {
  return {
    item: t("Item"),
    attachment: t("Attachment"),
    note: t("Note"),
    annotation: t("Annotation"),
    collection: t("Collection"),
    selection: t("Reader selection"),
  }[kind];
}

function safeFilename(value: string): string {
  return (
    [...value]
      .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
      .join("")
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "zaichat-conversation"
  );
}

export function SourceCard({
  source,
  sources = [source],
  allSources = sources,
  anchorPrefix = "",
  onLocate,
  onOpen,
}: {
  source: SourceReference;
  sources?: SourceReference[];
  allSources?: SourceReference[];
  anchorPrefix?: string;
  onLocate: (source: SourceReference) => void;
  onOpen: (source: SourceReference) => void;
}) {
  const t = useMenuText();
  const evidence = evidenceGroups(sources);
  const openSource = sources.find((entry) => entry.attachment) || source;
  const attachmentGroups = [
    ...new Set(
      evidence.map((entry) =>
        entry.source.attachment
          ? `${entry.source.attachment.libraryID}:${entry.source.attachment.itemKey}`
          : "metadata",
      ),
    ),
  ].map((key) =>
    evidence.filter(
      (entry) =>
        (entry.source.attachment
          ? `${entry.source.attachment.libraryID}:${entry.source.attachment.itemKey}`
          : "metadata") === key,
    ),
  );
  return (
    <div className="zaichat-source-entry">
      <strong>{source.label}</strong>
      <div className="zaichat-source-actions">
        <button onClick={() => onLocate(source)}>{t("定位")}</button>
        <button onClick={() => onOpen(openSource)}>{t("打开")}</button>
      </div>
      {(evidence.length > 0 || evidenceCoverage(source, t)) && (
        <details className="zaichat-source-evidence">
          <summary>
            {t("Evidence and reading coverage")} ·{" "}
            {t("{count} passages", { count: evidence.length })}
          </summary>
          {!evidence.length && <p>{evidenceCoverage(source, t)}</p>}
          {attachmentGroups.map((group) => (
            <section key={group[0].ids[0]} className="zaichat-attachment-evidence">
              <div className="zaichat-source-actions">
                <strong>
                  {group[0].source.attachment?.title ||
                    group[0].source.attachment?.itemKey ||
                    t("条目元数据")}
                </strong>
                {attachmentGroups.length > 1 && group[0].source.attachment && (
                  <button onClick={() => onOpen(group[0].source)}>
                    {t("打开此附件")}
                  </button>
                )}
              </div>
              {group.map((entry) => (
                <div key={entry.ids[0]} className="zaichat-evidence-passage">
                  {entry.ids.map((id) => (
                    <span key={id} id={`${anchorPrefix}${id}`} tabIndex={-1} />
                  ))}
                  <small>
                    {entry.ids
                      .map(
                        (id) =>
                          `[${allSources.findIndex((s) => s.sourceID === id) + 1}]`,
                      )
                      .join(" ")}{" "}
                    ·{" "}
                    {entry.source.field === "abstract"
                      ? t("摘要字段")
                      : entry.source.field === "fulltext"
                        ? t("附件原文")
                        : t("证据")}
                    {entry.source.attachment
                      ? ` · ${entry.source.attachment.itemKey}`
                      : ""}
                  </small>
                  <p>{entry.source.snippet}</p>
                  {evidenceCoverage(entry.source, t) && (
                    <p>{evidenceCoverage(entry.source, t)}</p>
                  )}
                </div>
              ))}
            </section>
          ))}
        </details>
      )}
    </div>
  );
}

async function copyText(win: _ZoteroTypes.MainWindow, value: string): Promise<void> {
  try {
    await win.navigator.clipboard.writeText(value);
  } catch {
    const helper = win.document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    (win.document.body || win.document.documentElement)?.append(helper);
    helper.select();
    win.document.execCommand("copy");
    helper.remove();
  }
}

function ApprovalCard({ manager, batch }: { manager: ChatManager; batch: any }) {
  const t = useMenuText();
  const [selected, setSelected] = useState<string[]>(
    batch.proposals.map((proposal: any) => proposal.id),
  );
  return (
    <div className="zaichat-approval zaichat-card">
      <strong>{t("Approval required")}</strong>
      {batch.proposals.map((proposal: any) => (
        <label key={proposal.id}>
          <input
            type="checkbox"
            checked={selected.includes(proposal.id)}
            onChange={() =>
              setSelected((values) =>
                values.includes(proposal.id)
                  ? values.filter((id) => id !== proposal.id)
                  : [...values, proposal.id],
              )
            }
          />{" "}
          {proposal.label}
        </label>
      ))}
      <div>
        <button disabled={!selected.length} onClick={() => manager.approve(selected)}>
          {t("Approve selected")}
        </button>{" "}
        <button onClick={() => manager.reject()}>{t("Reject")}</button>
      </div>
    </div>
  );
}
