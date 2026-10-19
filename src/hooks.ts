import { AgentRunner } from "./agent/agentRunner";
import { OpenAICompatibleProvider } from "./agent/modelProvider";
import { ToolRegistry } from "./agent/toolRegistry";
import { ChatManager } from "./core/chatManager";
import { ConversationRepository } from "./core/conversationRepository";
import { ContextManager } from "./core/contextManager";
import { SidebarHost } from "./host/sidebarHost";
import { ZoteroFileStore } from "./host/zoteroFileStore";
import { ZoteroRetriever } from "./host/zoteroRetriever";
import { WriteExecutor } from "./host/writeExecutor";
import { renderPreferences } from "./ui/preferences";
import { getPref, setPref, readModelProfiles } from "./utils/prefs";
import { FilePickerHelper } from "zotero-plugin-toolkit";
import { SearchLearningRepository } from "./core/searchLearningRepository";
import { createZoteroSemanticDataManager } from "./semantic/zoteroSemanticDataManager";
import { SEMANTIC_RUNTIME_MANIFEST } from "./semantic/releaseManifests";
import { e5ModelID, e5Manifest } from "./semantic/modelCatalog";
import { SemanticModelInstaller } from "./semantic/semanticModelInstaller";
import { hostMenuText } from "./host/uiLocale";

const hosts = new Map<Window, SidebarHost>();

async function onStartup(): Promise<void> {
  addon.data.startupStage = "waiting-for-zotero";
  try {
    addon.data.runtimeChecks = {
      abortController: typeof AbortController === "function",
      fetch: typeof fetch === "function",
      textDecoder: typeof TextDecoder === "function",
    };
    if (!Object.values(addon.data.runtimeChecks).every(Boolean))
      throw new Error("Required browser networking globals are unavailable");
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    addon.data.startupStage = "initializing-repository";
    const profileDir = String(
      (Zotero as any).Profile?.dir ||
        (Services as any).dirsvc.get("ProfD", (Components as any).interfaces.nsIFile)
          .path,
    );
    const activeModel = e5ModelID(getPref("semanticModelID"));
    addon.data.runtimeResourceRoot = rootURI;
    const semanticOptions = {
      profileDirectory: profileDir,
      customArtifactRoot:
        String(Services.env.get("ZAICHAT_SEMANTIC_ARTIFACT_ROOT") || "") ||
        String(getPref("semanticArtifactRoot") || ""),
      runtimeManifest: SEMANTIC_RUNTIME_MANIFEST,
      pluginRoot: rootURI,
      enrichMissingAbstracts: () => Boolean(getPref("semanticEnrichAbstracts")),
    };
    const createSemantic = (id: typeof activeModel) =>
      createZoteroSemanticDataManager({
        ...semanticOptions,
        modelManifest: e5Manifest(id),
      });
    const semanticManager = createSemantic(activeModel);
    addon.data.semanticModelInstaller = new SemanticModelInstaller(
      activeModel,
      createSemantic,
      (id) => setPref("semanticModelID", id),
      () =>
        Boolean(Zotero.isWin && String(Services.appinfo.XPCOMABI).includes("x86_64")),
    );
    addon.data.semanticManager = semanticManager;
    const retriever = new ZoteroRetriever(semanticManager);
    const repository = new ConversationRepository(
      new ZoteroFileStore(),
      PathUtils.join(profileDir, "zaichat"),
    );
    const learning = new SearchLearningRepository(
      new ZoteroFileStore(),
      PathUtils.join(profileDir, "zaichat", "search-learning.json"),
    );
    await learning.initialize();
    const manager = new ChatManager(
      repository,
      new ContextManager(retriever),
      new AgentRunner(
        new OpenAICompatibleProvider(),
        new ToolRegistry(retriever, learning),
      ),
      new WriteExecutor(),
      learning,
    );
    addon.data.manager = manager;
    await manager.initialize();
    if (getPref("semanticEnabled") !== false)
      void semanticManager
        .start()
        .catch((error) =>
          Zotero.logError(error instanceof Error ? error : new Error(String(error))),
        );
    addon.data.startupStage = "registering-preferences";
    addon.data.preferencePaneID = await Zotero.PreferencePanes.register({
      pluginID: "zaichat@booknary.github.io",
      id: "zaichat-preferences",
      src: `${rootURI}content/preferences.xhtml`,
      label: "ZaiChat",
      image: `${rootURI}content/icons/icon32.png`,
      stylesheets: [`${rootURI}content/styles/zaichat.css`],
    });
    addon.data.startupStage = "mounting-windows";
    for (const win of Zotero.getMainWindows()) await onMainWindowLoad(win);
    addon.data.initialized = true;
    addon.data.startupStage = "ready";
  } catch (error) {
    addon.data.startupStage = "failed";
    addon.data.startupError =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  if (!addon.data.manager || hosts.has(win)) return;
  win.MozXULElement.insertFTLIfNeeded("zaichat-mainWindow.ftl");
  const link = win.document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${rootURI}content/styles/zaichat.css`;
  link.id = "zaichat-styles";
  win.document.documentElement?.append(link);
  const host = new SidebarHost(
    win,
    addon.data.manager,
    () => {
      const profiles = readModelProfiles();
      return (
        profiles.find((profile) => profile.id === getPref("defaultModelProfileID")) ||
        profiles[0]
      );
    },
    () => ({
      systemPrompt: String(getPref("systemPrompt") || ""),
      maxToolCalls: Math.max(64, Number(getPref("maxToolCalls") || 80)),
      maxAttachments: Number(getPref("maxAttachments") || 20),
      developerDiagnostics: Boolean(getPref("developerDiagnostics")),
    }),
    (markdown, suggestedName) => exportMarkdown(win, markdown, suggestedName),
  );
  try {
    host.mount();
    hosts.set(win, host);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  hosts.get(win)?.unmount();
  hosts.delete(win);
  win.document.getElementById("zaichat-styles")?.remove();
}
async function onShutdown(): Promise<void> {
  for (const host of hosts.values()) host.unmount();
  hosts.clear();
  addon.data.manager?.stop();
  await addon.data.manager?.flush();
  await addon.data.semanticModelInstaller?.shutdown();
  await addon.data.semanticManager?.stop();
  addon.data.alive = false;
  delete (Zotero as any).ZaiChat;
}
function onPrefsEvent(type: string, data: { window: Window }): void {
  addon.data.preferenceEvent = type;
  if (type === "load") {
    try {
      renderPreferences(data.window);
    } catch (error) {
      addon.data.preferenceError = String(error);
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function openPreferences(): void {
  Zotero.Utilities.Internal.openPreferences(
    addon.data.preferencePaneID || "zaichat-preferences",
  );
}

async function exportMarkdown(
  win: Window,
  markdown: string,
  suggestedName: string,
): Promise<void> {
  const t = hostMenuText();
  try {
    const selected = await new FilePickerHelper(
      t("Export ZaiChat conversation"),
      "save",
      [["Markdown (*.md)", "*.md"]],
      suggestedName,
      win,
    ).open();
    if (!selected) return;
    const path = markdownPath(String(selected));
    await Zotero.File.putContentsAsync(path, markdown);
    (win as any).alert(t("Conversation exported to:\n{path}", { path }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(error instanceof Error ? error : new Error(message));
    (win as any).alert(t("Markdown export failed:\n{error}", { error: message }));
  }
}

export function markdownPath(selected: string): string {
  return selected.toLocaleLowerCase().endsWith(".md") ? selected : `${selected}.md`;
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
  openPreferences,
};
