import { createID } from "../utils/ids";
import {
  getPref,
  readModelProfiles,
  setPref,
  writeModelProfiles,
} from "../utils/prefs";
import { ModelProfile } from "../core/types";
import { resolveProviderCapabilities } from "../agent/providerCapabilities";
import { probeProviderCapabilities } from "../agent/providerProbe";
import { SemanticDataStatus } from "../semantic/semanticDataManager";
import { fetchModelCatalog } from "../agent/modelCatalog";
import { renderSemanticModelControls } from "./semanticModelControls";
import { hostMenuText } from "../host/uiLocale";

export function renderPreferences(win: Window): void {
  const t = hostMenuText();
  const doc = win.document;
  const root = doc.getElementById("zaichat-preferences-root");
  if (!root) return;
  root.replaceChildren();
  const profiles = readModelProfiles();
  const profile =
    profiles.find((entry) => entry.id === getPref("defaultModelProfileID")) ||
    profiles[0] ||
    ({
      id: createID("model"),
      displayName: "Default",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4.1-mini",
      protocol: "auto",
      streaming: true,
      reasoningEnabled: false,
      reasoningEffort: "medium",
      timeoutMs: 45000,
      contextBudgetChars: 100000,
      evidenceBudgetChars: 60000,
    } as any);

  const grid = element(doc, "div", "zaichat-pref-grid");
  const displayMode = element(doc, "select") as HTMLSelectElement;
  displayMode.id = "zaichat-display-mode";
  for (const [value, label] of [
    ["sidebar", t("侧栏")],
    ["window", t("独立窗口")],
  ]) {
    const option = element(doc, "option") as HTMLOptionElement;
    option.value = value;
    option.textContent = label;
    displayMode.append(option);
  }
  displayMode.value = getPref("displayMode") === "window" ? "window" : "sidebar";
  displayMode.addEventListener("change", () => {
    setPref("displayMode", displayMode.value);
    (Zotero as any).ZaiChat?.data?.manager?.settingsChanged();
  });
  const name = input(doc, "text", profile.displayName);
  const url = input(doc, "url", profile.baseURL);
  url.id = "zaichat-pref-base-url";
  const key = input(doc, "password", profile.apiKey);
  const model = input(doc, "text", profile.model);
  model.id = "zaichat-pref-model";
  const modelControls = element(doc, "div");
  const modelList = element(doc, "select") as HTMLSelectElement;
  modelList.setAttribute("aria-label", t("提供商模型列表"));
  const fetchModels = element(doc, "button") as HTMLButtonElement;
  fetchModels.textContent = t("获取模型列表");
  const catalogStatus = element(doc, "span");
  modelList.hidden = true;
  modelControls.append(model, fetchModels, modelList, catalogStatus);
  modelList.addEventListener("change", () => {
    if (modelList.value) {
      model.value = modelList.value;
      updateEffortOptions();
    }
  });
  let catalogRequest = 0;
  const invalidateCatalog = () => {
    catalogRequest++;
    modelList.hidden = true;
    catalogStatus.textContent = "";
  };
  url.addEventListener("input", invalidateCatalog);
  key.addEventListener("input", invalidateCatalog);
  fetchModels.addEventListener("click", async () => {
    const request = ++catalogRequest;
    fetchModels.disabled = true;
    catalogStatus.textContent = t("加载中…");
    try {
      const ids = await fetchModelCatalog(url.value, key.value);
      if (request !== catalogRequest || !root.isConnected) return;
      modelList.replaceChildren();
      for (const id of ["", ...ids]) {
        const option = element(doc, "option") as HTMLOptionElement;
        option.value = id;
        option.textContent = id || t("请选择模型");
        modelList.append(option);
      }
      modelList.value = ids.includes(model.value) ? model.value : "";
      modelList.hidden = false;
      catalogStatus.textContent = t(
        "{count} models; save after choosing. Chat/tool support is not guaranteed.",
        { count: ids.length },
      );
    } catch (error) {
      if (request === catalogRequest)
        catalogStatus.textContent = (error as Error).message;
    } finally {
      fetchModels.disabled = false;
    }
  });
  const protocol = element(doc, "select") as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", t("Auto")],
    ["native-tools", t("Native tools")],
    ["json-actions", t("Strict JSON actions")],
  ]) {
    const option = element(doc, "option") as HTMLOptionElement;
    option.value = value;
    option.textContent = label;
    protocol.append(option);
  }
  protocol.value = profile.protocol;
  const streaming = input(doc, "checkbox") as HTMLInputElement;
  streaming.checked = profile.streaming;
  const reasoning = input(doc, "checkbox") as HTMLInputElement;
  reasoning.id = "zaichat-pref-reasoning-enabled";
  reasoning.checked = profile.reasoningEnabled;
  const effort = element(doc, "select") as HTMLSelectElement;
  effort.id = "zaichat-pref-reasoning-effort";
  const updateEffortOptions = () => {
    const capabilities = resolveProviderCapabilities({
      baseURL: url.value,
      model: model.value,
    });
    const previous = effort.value || profile.reasoningEffort;
    effort.replaceChildren();
    for (const value of capabilities.reasoningEffortValues) {
      const option = element(doc, "option") as HTMLOptionElement;
      option.value = value;
      option.textContent = t(value);
      effort.append(option);
    }
    effort.value = Array.from(effort.options).some(
      (option) => (option as HTMLOptionElement).value === previous,
    )
      ? previous
      : capabilities.id === "official-deepseek-v4"
        ? "high"
        : "medium";
  };
  url.addEventListener("input", updateEffortOptions);
  model.addEventListener("input", updateEffortOptions);
  updateEffortOptions();
  const system = element(doc, "textarea") as HTMLTextAreaElement;
  system.rows = 5;
  system.value = String(getPref("systemPrompt") || "");
  const tools = input(
    doc,
    "number",
    String(Math.max(64, Number(getPref("maxToolCalls") || 80))),
  );
  tools.min = "64";
  tools.max = "100";
  const developerDiagnostics = input(doc, "checkbox") as HTMLInputElement;
  developerDiagnostics.checked = Boolean(getPref("developerDiagnostics"));
  const attachments = input(doc, "number", String(getPref("maxAttachments") || 20));
  attachments.min = "1";
  attachments.max = "50";
  const requestTimeout = input(doc, "number", String(profile.timeoutMs / 1000));
  requestTimeout.min = "5";
  requestTimeout.max = "600";
  requestTimeout.title = t(
    "Stream idle timeout. Reasoning requests wait at least 180 seconds initially; total duration is bounded to at least 600 seconds.",
  );
  const contextBudget = input(doc, "number", String(profile.contextBudgetChars));
  contextBudget.min = "10000";
  contextBudget.max = "500000";
  contextBudget.step = "1000";
  const evidenceBudget = input(doc, "number", String(profile.evidenceBudgetChars));
  evidenceBudget.min = "5000";
  evidenceBudget.max = "300000";
  evidenceBudget.step = "1000";
  const semanticEnabled = input(doc, "checkbox") as HTMLInputElement;
  semanticEnabled.checked = getPref("semanticEnabled") !== false;
  const semanticEnrichAbstracts = input(doc, "checkbox") as HTMLInputElement;
  semanticEnrichAbstracts.checked = Boolean(getPref("semanticEnrichAbstracts"));
  const semanticArtifactRoot = input(
    doc,
    "text",
    String(getPref("semanticArtifactRoot") || ""),
  );
  semanticArtifactRoot.placeholder = t("Default: Zotero profile/zaichat");
  for (const [label, control] of [
    [t("聊天显示方式（立即生效）"), displayMode],
    [t("Profile name"), name],
    [t("API base URL"), url],
    [t("API key"), key],
    [t("Model"), modelControls],
    [t("Protocol"), protocol],
    [t("Streaming"), streaming],
    [t("Enable reasoning"), reasoning],
    [t("Reasoning effort"), effort],
    [t("Response / stream idle timeout (seconds)"), requestTimeout],
    [t("System prompt"), system],
    [t("Emergency tool-call fuse"), tools],
    [t("Max attachments"), attachments],
    [t("Developer diagnostics"), developerDiagnostics],
    [t("Context budget (characters)"), contextBudget],
    [t("Evidence budget (characters)"), evidenceBudget],
    [t("Enable local semantic search"), semanticEnabled],
    [t("Fetch missing abstracts for semantic indexing"), semanticEnrichAbstracts],
    [t("Optional model storage directory"), semanticArtifactRoot],
  ] as Array<[string, HTMLElement]>) {
    const labelElement = element(doc, "label");
    labelElement.textContent = label;
    grid.append(labelElement, control);
  }
  const disclosure = element(doc, "p", "zaichat-muted");
  disclosure.textContent = t(
    "The API key is stored in Zotero preferences and is not protected by an operating-system keychain. Queries, selected context, candidate metadata, and bounded snippets are sent only to the configured model service. Complete attachments and the Zotero database are never uploaded wholesale.",
  );
  const save = element(doc, "button") as HTMLButtonElement;
  save.id = "zaichat-pref-save";
  save.textContent = t("Save model profile");
  save.addEventListener("click", () => {
    try {
      const updated = {
        ...profile,
        displayName: name.value,
        baseURL: url.value,
        apiKey: key.value,
        model: model.value,
        protocol: protocol.value as any,
        streaming: streaming.checked,
        reasoningEnabled: reasoning.checked,
        reasoningEffort: effort.value as ModelProfile["reasoningEffort"],
        timeoutMs: Math.max(
          5000,
          Math.min(600000, Number(requestTimeout.value) * 1000 || 45000),
        ),
        contextBudgetChars: Math.max(
          10000,
          Math.min(500000, Number(contextBudget.value) || 100000),
        ),
        evidenceBudgetChars: Math.max(
          5000,
          Math.min(300000, Number(evidenceBudget.value) || 60000),
        ),
      };
      writeModelProfiles(
        readModelProfiles()
          .filter((entry) => entry.id !== updated.id)
          .concat(updated),
      );
      setPref("defaultModelProfileID", updated.id);
      (Zotero as any).ZaiChat?.data?.manager?.settingsChanged();
      setPref("systemPrompt", system.value);
      setPref("maxToolCalls", Math.max(64, Math.min(100, Number(tools.value) || 80)));
      setPref(
        "maxAttachments",
        Math.max(1, Math.min(50, Number(attachments.value) || 20)),
      );
      setPref("developerDiagnostics", developerDiagnostics.checked);
      setPref("semanticEnabled", semanticEnabled.checked);
      setPref("semanticEnrichAbstracts", semanticEnrichAbstracts.checked);
      setPref("semanticArtifactRoot", semanticArtifactRoot.value.trim());
      const semanticManager = (Zotero as any).ZaiChat?.data?.semanticManager;
      if (semanticManager)
        void (
          semanticEnabled.checked ? semanticManager.start() : semanticManager.stop()
        ).catch((error: unknown) =>
          Zotero.logError(error instanceof Error ? error : new Error(String(error))),
        );
      win.alert(t("ZaiChat settings saved."));
    } catch (error) {
      win.alert(error instanceof Error ? error.message : t("设置保存失败。"));
    }
  });
  const test = element(doc, "button") as HTMLButtonElement;
  test.id = "zaichat-pref-test";
  test.textContent = t("Test connection");
  const status = element(doc, "span", "zaichat-pref-test-status");
  test.addEventListener("click", async () => {
    test.disabled = true;
    status.classList.remove("zaichat-error");
    status.textContent = t("Testing…");
    try {
      const result = await testModelConnection(
        {
          ...profile,
          baseURL: url.value.trim().replace(/\/+$/, ""),
          apiKey: key.value.trim(),
          model: model.value.trim(),
          streaming: streaming.checked,
          reasoningEnabled: reasoning.checked,
          reasoningEffort: effort.value as ModelProfile["reasoningEffort"],
        },
        win,
      );
      status.textContent = result;
    } catch (error) {
      status.classList.add("zaichat-error");
      status.textContent =
        error instanceof Error ? error.message : t("Connection test failed.");
    } finally {
      test.disabled = false;
    }
  });
  const actions = element(doc, "div", "zaichat-pref-actions");
  actions.append(save, test, status);
  const semantic = renderSemanticControls(win);
  root.append(grid, disclosure, actions, semantic);
}

function renderSemanticControls(win: Window): HTMLElement {
  const t = hostMenuText();
  const doc = win.document;
  const section = element(doc, "section", "zaichat-semantic-settings");
  const heading = element(doc, "h2");
  heading.textContent = t("Local semantic index");
  const status = element(doc, "pre", "zaichat-semantic-status");
  status.textContent = t("Checking local runtime, model, and index…");
  const actions = element(doc, "div", "zaichat-pref-actions");
  const manager = (Zotero as any).ZaiChat?.data?.semanticManager;
  let busy = false;
  const refresh = async () => {
    if (!manager || busy) return;
    try {
      status.classList.remove("zaichat-error");
      status.textContent = semanticStatusText(await manager.inspect());
    } catch (error) {
      status.classList.add("zaichat-error");
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  const action = (
    label: string,
    operation: () => Promise<unknown>,
    confirmation?: string,
  ) => {
    const button = element(doc, "button") as HTMLButtonElement;
    button.textContent = label;
    button.disabled = !manager;
    button.addEventListener("click", async () => {
      if ((Zotero as any).ZaiChat?.data?.semanticModelInstaller?.busy) {
        status.textContent = t("请先等待模型部署完成或取消下载。");
        return;
      }
      if (confirmation && !(win as any).confirm(confirmation)) return;
      busy = true;
      for (const child of Array.from(actions.children))
        (child as HTMLButtonElement).disabled = true;
      status.textContent = `${label}…`;
      try {
        await operation();
        status.classList.remove("zaichat-error");
      } catch (error) {
        status.classList.add("zaichat-error");
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        for (const child of Array.from(actions.children))
          (child as HTMLButtonElement).disabled = !manager;
        await refresh();
      }
    });
    actions.append(button);
  };
  action(t("Refresh"), async () => undefined);
  action(t("Start"), () => manager.start());
  action(t("Pause"), () => manager.pauseIndexing());
  action(t("Resume"), () => manager.resumeIndexing());
  action(t("Cancel"), () => manager.cancelIndexing());
  action(t("Rebuild index"), () => manager.rebuildIndex());
  action(
    t("Clear index"),
    () => manager.clearIndex(true),
    t(
      "Clear the local semantic index? The Zotero database and library items will not be modified.",
    ),
  );
  action(
    t("Delete all semantic data"),
    () => manager.deleteAllSemanticData(true),
    t(
      "Delete the local embedding runtime, model, and semantic index? Zotero library data will not be modified.",
    ),
  );
  const note = element(doc, "p", "zaichat-muted");
  note.textContent = t(
    "The semantic database is stored separately from Zotero. Indexing includes paper titles, abstracts, and tags only. Optional abstract completion sends exact DOIs (not PDFs, notes, or Zotero keys) to OpenAlex, verifies the returned title, and stores the result only in ZaiChat semantic data; use Rebuild index after changing it. Changing the model storage directory takes effect after Zotero restarts.",
  );
  const distributionNotice = element(doc, "p", "zaichat-muted");
  distributionNotice.textContent = t(
    "Windows x64 runtime is bundled. Choose and deploy a model below for first use; Start only starts installed components. Model switching takes effect after restart. Lexical retrieval remains available during initial indexing.",
  );
  section.append(
    heading,
    distributionNotice,
    renderSemanticModelControls(win),
    status,
    actions,
    note,
  );
  if (!manager) status.textContent = t("Semantic manager is unavailable.");
  else void refresh();
  return section;
}

function semanticStatusText(value: SemanticDataStatus): string {
  const t = hostMenuText();
  const progress = value.subsystem.indexing;
  const progressText = progress
    ? t("{done}/{total} items, {vectors} vectors", {
        done: progress.completedItems,
        total: progress.totalItems,
        vectors: progress.vectorCount,
      })
    : t("not started");
  return [
    `${t("State")}: ${t(value.subsystem.state)}${value.subsystem.failure ? ` — ${value.subsystem.failure}` : ""}`,
    `${t("Runtime")}: ${value.runtime.verified ? t("ready") : t("not installed")}`,
    `${t("Model")}: ${value.model.verified ? t("ready") : t("not installed")} (${value.modelFingerprint.modelID})`,
    `${t("Index")}: ${progressText}`,
    `${t("Disk usage")}: ${formatBytes(value.totalDiskUsage)}`,
    `${t("Model location")}: ${value.model.location}`,
  ].join("\n");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function testModelConnection(
  profile: ModelProfile,
  _win: Window,
): Promise<string> {
  const t = hostMenuText();
  if (!profile.baseURL || !profile.model)
    throw new Error(t("Enter an API base URL and model first."));
  if (!profile.apiKey) throw new Error(t("Enter an API key first."));
  const checks = await probeProviderCapabilities(profile);
  return checks
    .map(
      (check) =>
        `${t(check.name).padEnd(20)} ${t(check.status)}${check.detail ? ` — ${check.detail}` : ""}`,
    )
    .join("\n");
}

function element(doc: Document, tag: string, className?: string): HTMLElement {
  const result = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (className) result.setAttribute("class", className);
  return result;
}

function input(doc: Document, type: string, value = ""): HTMLInputElement {
  const result = element(doc, "input") as HTMLInputElement;
  result.type = type;
  result.value = value;
  return result;
}
